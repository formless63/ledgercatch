/**
 * IMAP mailbox poller: new messages since the last seen UID become email
 * captures (ingestRawEmail). Point it at a dedicated folder/label (e.g. a
 * Gmail label filled by a filter) or a whole inbox with a sender allowlist.
 *
 * Cursor: { uidValidity, lastUid, failedUid?, failedAttempts? }. A message
 * that keeps failing is skipped after 3 polls so it cannot block the queue.
 */
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { decryptSecret } from "#/features/connectors/crypto.server";
import { emailDomain } from "#/features/parsing/email/detect";
import { ingestRawEmail } from "../email/ingest.server";
import { MAX_EMAIL_BYTES } from "../email/mime.server";
import type { IngressSourceRow, SourceModule } from "../types";

const MAX_PER_POLL = 50;
const MAX_FAILED_ATTEMPTS = 3;

const boolish = z.preprocess(
	(v) => (typeof v === "string" ? v === "true" || v === "on" || v === "1" : v),
	z.boolean(),
);
const optionalText = z.preprocess(
	(v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
	z.string().trim().max(500).optional(),
);

export const imapConfigSchema = z.object({
	host: z.string().trim().min(1).max(255),
	port: z.coerce.number().int().min(1).max(65535).default(993),
	tls: boolish.default(true),
	mailbox: z.preprocess(
		(v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
		z.string().trim().max(500).default("INBOX"),
	),
	markSeen: boolish.default(false),
	moveTo: optionalText,
	/** Comma/space separated sender domains; empty = accept everything. */
	onlyFrom: optionalText,
	/** First run only: import messages from the last N days. */
	backfillDays: z.coerce.number().int().min(0).max(3650).default(30),
});
export type ImapConfig = z.output<typeof imapConfigSchema>;

export const imapSecretSchema = z.object({
	username: z.string().min(1).max(500),
	password: z.string().min(1).max(2000),
});

type ImapCursor = {
	uidValidity?: string;
	lastUid?: number;
	failedUid?: number;
	failedAttempts?: number;
};

function loadSource(source: IngressSourceRow) {
	const config = imapConfigSchema.parse(source.config ?? {});
	if (!source.secretCiphertext)
		throw new Error("IMAP credentials are missing — edit the source");
	const secret = imapSecretSchema.parse(
		decryptSecret<unknown>(source.secretCiphertext),
	);
	return { config, secret };
}

function client(config: ImapConfig, secret: z.output<typeof imapSecretSchema>) {
	return new ImapFlow({
		host: config.host,
		port: config.port,
		secure: config.tls,
		auth: { user: secret.username, pass: secret.password },
		logger: false,
		connectionTimeout: 20_000,
		greetingTimeout: 15_000,
		socketTimeout: 120_000,
	});
}

function friendlyError(error: unknown): Error {
	const e = error as {
		authenticationFailed?: boolean;
		responseText?: string;
		code?: string;
		message?: string;
	};
	if (e?.authenticationFailed)
		return new Error(
			`Authentication failed${e.responseText ? `: ${e.responseText}` : ""} (Gmail/Outlook need an app password)`,
		);
	if (e?.code === "ENOTFOUND") return new Error("IMAP host not found");
	if (e?.code === "ECONNREFUSED") return new Error("Connection refused");
	if (e?.code === "ETIMEDOUT" || e?.code === "CONNECT_TIMEOUT")
		return new Error("Connection timed out");
	return new Error(e?.responseText || e?.message || String(error));
}

export function allowedSender(
	address: string | undefined,
	onlyFrom: string | undefined,
): boolean {
	if (!onlyFrom) return true;
	const domains = onlyFrom
		.split(/[\s,;]+/)
		.map((d) => d.trim().toLowerCase().replace(/^@/, ""))
		.filter(Boolean);
	if (domains.length === 0) return true;
	const domain = emailDomain(address);
	return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

async function connected<T>(
	source: IngressSourceRow,
	work: (imap: ImapFlow, config: ImapConfig) => Promise<T>,
): Promise<T> {
	const { config, secret } = loadSource(source);
	const imap = client(config, secret);
	// Socket errors are also emitted; without a listener they crash the worker.
	imap.on("error", () => {});
	try {
		await imap.connect();
	} catch (error) {
		throw friendlyError(error);
	}
	try {
		return await work(imap, config);
	} catch (error) {
		throw friendlyError(error);
	} finally {
		await imap.logout().catch(() => imap.close());
	}
}

async function pollImap(source: IngressSourceRow) {
	return connected(source, async (imap, config) => {
		const lock = await imap.getMailboxLock(config.mailbox);
		try {
			const mailbox = imap.mailbox;
			if (!mailbox) throw new Error(`Could not open ${config.mailbox}`);
			const prev = (source.cursor ?? {}) as ImapCursor;
			const uidValidity = String(mailbox.uidValidity);
			const sameMailbox = prev.uidValidity === uidValidity;
			const lastUid = sameMailbox ? (prev.lastUid ?? 0) : 0;

			let uids: number[];
			if (!sameMailbox || !prev.lastUid) {
				// First run (or the mailbox was recreated): bounded backfill.
				const since = new Date(Date.now() - config.backfillDays * 86_400_000);
				const found = await imap.search(
					config.backfillDays > 0 ? { since } : { all: true },
					{ uid: true },
				);
				uids = found || [];
			} else {
				const found = await imap.search(
					{ uid: `${lastUid + 1}:*` },
					{ uid: true },
				);
				// "N:*" always matches the newest message, even when its UID < N.
				uids = (found || []).filter((uid) => uid > lastUid);
			}
			uids.sort((a, b) => a - b);
			const pending = uids.length;
			uids = uids.slice(0, MAX_PER_POLL);
			if (uids.length === 0)
				return {
					cursor: { uidValidity, lastUid } satisfies ImapCursor,
					created: 0,
					summary: `${config.mailbox}: no new messages`,
				};

			const meta = new Map<number, { size?: number; from?: string }>();
			for await (const msg of imap.fetch(
				uids.join(","),
				{ uid: true, size: true, envelope: true },
				{ uid: true },
			))
				meta.set(msg.uid, {
					size: msg.size,
					from: msg.envelope?.from?.[0]?.address,
				});

			let cursorUid = lastUid;
			let created = 0;
			let duplicates = 0;
			let skipped = 0;
			let failure: { uid: number; message: string } | undefined;
			let failedAttempts = 0;
			for (const uid of uids) {
				const info = meta.get(uid);
				if (!info) {
					cursorUid = uid; // expunged meanwhile
					continue;
				}
				if (
					(info.size ?? 0) > MAX_EMAIL_BYTES ||
					!allowedSender(info.from, config.onlyFrom)
				) {
					skipped++;
					cursorUid = uid;
					continue;
				}
				try {
					const full = await imap.fetchOne(
						String(uid),
						{ source: true },
						{ uid: true },
					);
					if (!full || !full.source) throw new Error("message vanished");
					const result = await ingestRawEmail(
						source.ownerId,
						new Uint8Array(full.source),
						{ via: "imap", sourceId: source.id, mailbox: config.mailbox, uid },
					);
					if (result.created) created++;
					else duplicates++;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					const attempts =
						prev.failedUid === uid ? (prev.failedAttempts ?? 0) + 1 : 1;
					if (attempts < MAX_FAILED_ATTEMPTS) {
						// Stop here; retry this UID next poll.
						failure = { uid, message };
						failedAttempts = attempts;
						break;
					}
					skipped++;
					cursorUid = uid;
					continue;
				}
				cursorUid = uid;
				if (config.markSeen)
					await imap
						.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true })
						.catch(() => false);
				if (config.moveTo)
					await imap
						.messageMove(String(uid), config.moveTo, { uid: true })
						.catch(() => false);
			}
			const parts = [
				`${config.mailbox}: ${created} new`,
				duplicates ? `${duplicates} already imported` : "",
				skipped ? `${skipped} skipped` : "",
				pending > uids.length ? `${pending - uids.length} more queued` : "",
				failure
					? `UID ${failure.uid} failed (attempt ${failedAttempts}/${MAX_FAILED_ATTEMPTS}): ${failure.message}`
					: "",
			].filter(Boolean);
			return {
				cursor: {
					uidValidity,
					lastUid: cursorUid,
					...(failure ? { failedUid: failure.uid, failedAttempts } : {}),
				} satisfies ImapCursor,
				created,
				summary: parts.join(", "),
			};
		} finally {
			lock.release();
		}
	});
}

export const imapSource: SourceModule = {
	label: "IMAP mailbox",
	description:
		"Polls a mailbox (or a dedicated folder/label) for order confirmations, shipping notices and invoices. Gmail/Outlook/iCloud need an app password.",
	configFields: [
		{
			key: "host",
			label: "IMAP host",
			type: "text",
			placeholder: "imap.gmail.com",
			required: true,
		},
		{ key: "port", label: "Port", type: "number", placeholder: "993" },
		{
			key: "tls",
			label: "Use TLS (port 993). Off = STARTTLS when offered",
			type: "checkbox",
		},
		{
			key: "mailbox",
			label: "Mailbox / folder",
			type: "text",
			placeholder: "INBOX",
			help: "A Gmail label is a folder, e.g. “Orders”. Default INBOX.",
		},
		{
			key: "onlyFrom",
			label: "Only import from sender domains",
			type: "text",
			placeholder: "amazon.com, ebay.com, digikey.com",
			help: "Optional allowlist (subdomains match). Include your own domain to keep forwarded mail.",
		},
		{
			key: "backfillDays",
			label: "First run: import last N days",
			type: "number",
			placeholder: "30",
		},
		{
			key: "markSeen",
			label: "Mark imported messages as read",
			type: "checkbox",
		},
		{
			key: "moveTo",
			label: "Move imported messages to folder",
			type: "text",
			placeholder: "Orders/Imported",
			help: "Optional; the folder must exist.",
		},
	],
	secretFields: [
		{ key: "username", label: "Username", type: "text", required: true },
		{
			key: "password",
			label: "Password / app password",
			type: "password",
			required: true,
		},
	],
	poll: pollImap,
	async test(source) {
		try {
			return await connected(source, async (imap, config) => {
				const status = await imap.status(config.mailbox, {
					messages: true,
					unseen: true,
					uidNext: true,
				});
				if (!status)
					return {
						ok: false,
						message: `Mailbox “${config.mailbox}” not found`,
					};
				if (config.moveTo) {
					const folders = await imap.list();
					if (!folders.some((f) => f.path === config.moveTo))
						return {
							ok: false,
							message: `Connected, but move-to folder “${config.moveTo}” does not exist`,
						};
				}
				return {
					ok: true,
					message: `Connected to ${config.host} — ${config.mailbox}: ${status.messages ?? 0} messages (${status.unseen ?? 0} unseen)`,
				};
			});
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},
};
