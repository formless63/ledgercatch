/**
 * Owner-scoped management of ingress sources (Settings → Sources). Generic
 * over SourceModule: forms are generated from configFields/secretFields,
 * secrets are write-only (encrypted at rest), push tokens are shown once.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "#/db";
import { env } from "#/env";
import {
	assertEncryptionKeyConfigured,
	decryptSecret,
	encryptSecret,
} from "#/features/connectors/crypto.server";
import { requireUser } from "#/features/ledger/ledger.server";
import { generatePushToken } from "./email/inbound.server";
import { pollSource } from "./poll.server";
import {
	INGRESS_SOURCE_KINDS,
	type IngressSourceKind,
	ingressSources,
} from "./schema";
import { getSourceModule } from "./sources/registry.server";
import type { IngressSourceRow, SourceField } from "./types";

export type SourceKindMeta = {
	kind: IngressSourceKind;
	label: string;
	description: string;
	configFields: SourceField[];
	secretFields: SourceField[];
	/** Push-only (webhook) source: no polling, no interval. */
	push: boolean;
};

const INBOUND_EMAIL_META: SourceKindMeta = {
	kind: "inbound_email",
	label: "Forwarding address (webhook)",
	description:
		"A private URL that accepts raw emails (Cloudflare Email Routing worker, Mailgun/SendGrid/Postmark inbound, or curl from fetchmail). Forward order confirmations to the address you route to it.",
	configFields: [],
	secretFields: [],
	push: true,
};

export async function listSourceKinds(): Promise<SourceKindMeta[]> {
	const out: SourceKindMeta[] = [];
	for (const kind of INGRESS_SOURCE_KINDS) {
		if (kind === "inbound_email") {
			out.push(INBOUND_EMAIL_META);
			continue;
		}
		const module = await getSourceModule(kind);
		if (!module) continue;
		out.push({
			kind,
			label: module.label,
			description: module.description,
			configFields: module.configFields,
			secretFields: module.secretFields,
			push: false,
		});
	}
	return out;
}

async function kindMeta(kind: IngressSourceKind): Promise<SourceKindMeta> {
	const meta = (await listSourceKinds()).find((k) => k.kind === kind);
	if (!meta) throw new Error(`Unknown source kind: ${kind}`);
	return meta;
}

export function webhookUrl(token: string): string {
	return `${env.APP_BASE_URL.replace(/\/+$/, "")}/api/inbound/email/${token}`;
}

/* ------------------------------------------------------------------------ */
/* Field coercion                                                            */
/* ------------------------------------------------------------------------ */

type RawValues = Record<string, unknown>;

function coerceField(field: SourceField, value: unknown): unknown {
	if (value === undefined || value === null) return undefined;
	switch (field.type) {
		case "checkbox":
			return value === true || value === "true" || value === "on";
		case "number": {
			if (value === "") return undefined;
			const n = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(n))
				throw new Error(`${field.label} must be a number`);
			return n;
		}
		case "select": {
			const s = String(value);
			if (s === "") return undefined;
			if (field.options && !field.options.some((o) => o.value === s))
				throw new Error(`${field.label}: invalid option`);
			return s;
		}
		case "url": {
			const s = String(value).trim();
			if (!s) return undefined;
			try {
				const url = new URL(s);
				if (url.protocol !== "https:" && url.protocol !== "http:")
					throw new Error("bad protocol");
			} catch {
				throw new Error(`${field.label} must be an http(s) URL`);
			}
			return s.replace(/\/+$/, "");
		}
		default: {
			const s = String(value);
			if (s.length > 4000) throw new Error(`${field.label} is too long`);
			return field.type === "password" ? s : s.trim() || undefined;
		}
	}
}

/** Known keys only, typed per field; `required` enforced when `strict`. */
function coerceValues(
	fields: SourceField[],
	values: RawValues | undefined,
	strict: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		const v = coerceField(field, values?.[field.key]);
		if (v !== undefined && v !== "") out[field.key] = v;
		else if (strict && field.required)
			throw new Error(`${field.label} is required`);
	}
	return out;
}

/* ------------------------------------------------------------------------ */
/* Queries / mutations                                                       */
/* ------------------------------------------------------------------------ */

/** JSON-serializable view of stored config values (server-fn boundary). */
export type ConfigValues = Record<string, string | number | boolean | null>;

function publicRow(row: IngressSourceRow) {
	const { secretCiphertext, pushTokenHash, cursor, config, ...rest } = row;
	return {
		...rest,
		config: (config ?? {}) as ConfigValues,
		hasSecret: Boolean(secretCiphertext),
		hasPushToken: Boolean(pushTokenHash),
		cursorSummary: cursor ? JSON.stringify(cursor).slice(0, 200) : null,
	};
}
export type SourceRow = ReturnType<typeof publicRow>;

async function ownedSource(ownerId: string, id: string) {
	const [row] = await db
		.select()
		.from(ingressSources)
		.where(and(eq(ingressSources.id, id), eq(ingressSources.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

export async function listSourcesForOwner(ownerId: string) {
	const rows = await db
		.select()
		.from(ingressSources)
		.where(eq(ingressSources.ownerId, ownerId))
		.orderBy(desc(ingressSources.createdAt));
	return rows.map(publicRow);
}

export type SourceCreateInput = {
	kind: IngressSourceKind;
	name: string;
	config?: RawValues;
	secret?: RawValues;
	intervalMinutes?: number;
	enabled?: boolean;
};

export async function createSourceForOwner(
	ownerId: string,
	input: SourceCreateInput,
) {
	const meta = await kindMeta(input.kind);
	const config = coerceValues(meta.configFields, input.config, true);
	const secret = coerceValues(meta.secretFields, input.secret, true);
	let secretCiphertext: string | null = null;
	if (meta.secretFields.length) {
		assertEncryptionKeyConfigured();
		secretCiphertext = encryptSecret(secret);
	}
	const push = meta.push ? generatePushToken() : undefined;
	const [row] = await db
		.insert(ingressSources)
		.values({
			ownerId,
			kind: input.kind,
			name: input.name.trim(),
			config,
			secretCiphertext,
			enabled: input.enabled === false ? "off" : "on",
			intervalMinutes: input.intervalMinutes ?? 10,
			status: meta.push ? "ok" : "untested",
			pushTokenHash: push?.hash ?? null,
		})
		.returning();
	if (!row) throw new Error("Could not create source");
	return {
		source: publicRow(row),
		token: push?.token ?? null,
		webhookUrl: push ? webhookUrl(push.token) : null,
	};
}

export type SourceUpdateInput = {
	id: string;
	name?: string;
	config?: RawValues;
	/** Only non-empty values replace stored secrets (write-only fields). */
	secret?: RawValues;
	intervalMinutes?: number;
	enabled?: boolean;
};

export async function updateSourceForOwner(
	ownerId: string,
	input: SourceUpdateInput,
) {
	const row = await ownedSource(ownerId, input.id);
	const meta = await kindMeta(row.kind);
	const patch: Partial<typeof ingressSources.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (input.name !== undefined) patch.name = input.name.trim();
	if (input.config !== undefined)
		patch.config = coerceValues(meta.configFields, input.config, true);
	if (input.intervalMinutes !== undefined)
		patch.intervalMinutes = input.intervalMinutes;
	if (input.enabled !== undefined) patch.enabled = input.enabled ? "on" : "off";
	if (input.secret && meta.secretFields.length) {
		const provided = coerceValues(meta.secretFields, input.secret, false);
		if (Object.keys(provided).length) {
			assertEncryptionKeyConfigured();
			let current: Record<string, unknown> = {};
			if (row.secretCiphertext)
				try {
					current = decryptSecret<Record<string, unknown>>(
						row.secretCiphertext,
					);
				} catch {
					current = {};
				}
			const merged = { ...current, ...provided };
			for (const field of meta.secretFields)
				if (field.required && !merged[field.key])
					throw new Error(`${field.label} is required`);
			patch.secretCiphertext = encryptSecret(merged);
		}
	}
	// Connection settings changed → previous test result no longer applies.
	if ((patch.config || patch.secretCiphertext) && !meta.push) {
		patch.status = "untested";
		patch.lastError = null;
	}
	const [updated] = await db
		.update(ingressSources)
		.set(patch)
		.where(
			and(eq(ingressSources.id, row.id), eq(ingressSources.ownerId, ownerId)),
		)
		.returning();
	if (!updated) throw new Error("NOT_FOUND");
	return publicRow(updated);
}

export async function deleteSourceForOwner(ownerId: string, id: string) {
	await ownedSource(ownerId, id);
	await db
		.delete(ingressSources)
		.where(and(eq(ingressSources.id, id), eq(ingressSources.ownerId, ownerId)));
	return { ok: true };
}

export async function testSourceForOwner(ownerId: string, id: string) {
	const row = await ownedSource(ownerId, id);
	const module = await getSourceModule(row.kind);
	let result: { ok: boolean; message: string };
	if (!module)
		result = row.pushTokenHash
			? {
					ok: true,
					message:
						"Push source: send a test email through your forwarder and check Captures.",
				}
			: { ok: false, message: "No webhook token — rotate to create one." };
	else
		try {
			result = await module.test(row);
		} catch (error) {
			result = {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	await db
		.update(ingressSources)
		.set({
			status: result.ok ? "ok" : "error",
			lastError: result.ok ? null : result.message.slice(0, 2000),
			updatedAt: new Date(),
		})
		.where(eq(ingressSources.id, row.id));
	return result;
}

/** Runs one poll inline (bounded per module) and reports its summary. */
export async function pollSourceNowForOwner(ownerId: string, id: string) {
	const row = await ownedSource(ownerId, id);
	if (row.enabled !== "on")
		return { ok: false, message: "Source is disabled — enable it first." };
	const module = await getSourceModule(row.kind);
	if (!module)
		return {
			ok: false,
			message: "Push sources receive email via the webhook; nothing to poll.",
		};
	const result = await pollSource(row.id);
	if ("failed" in result) return { ok: false, message: String(result.failed) };
	if ("skipped" in result)
		return { ok: false, message: String(result.skipped) };
	return {
		ok: true,
		message: result.summary || `${result.created} new capture(s)`,
		created: result.created,
	};
}

export async function rotatePushTokenForOwner(ownerId: string, id: string) {
	const row = await ownedSource(ownerId, id);
	if (row.kind !== "inbound_email")
		throw new Error("Only inbound email sources have a webhook token");
	const push = generatePushToken();
	await db
		.update(ingressSources)
		.set({ pushTokenHash: push.hash, updatedAt: new Date() })
		.where(eq(ingressSources.id, row.id));
	return { token: push.token, webhookUrl: webhookUrl(push.token) };
}

/* Session wrappers ------------------------------------------------------- */

export async function listSources() {
	const user = await requireUser();
	return {
		sources: await listSourcesForOwner(user.id),
		kinds: await listSourceKinds(),
		webhookBase: webhookUrl("").replace(/\/$/, ""),
	};
}
export async function createSource(input: SourceCreateInput) {
	const user = await requireUser();
	return createSourceForOwner(user.id, input);
}
export async function updateSource(input: SourceUpdateInput) {
	const user = await requireUser();
	return updateSourceForOwner(user.id, input);
}
export async function deleteSource(id: string) {
	const user = await requireUser();
	return deleteSourceForOwner(user.id, id);
}
export async function testSource(id: string) {
	const user = await requireUser();
	return testSourceForOwner(user.id, id);
}
export async function pollSourceNow(id: string) {
	const user = await requireUser();
	return pollSourceNowForOwner(user.id, id);
}
export async function rotatePushToken(id: string) {
	const user = await requireUser();
	return rotatePushTokenForOwner(user.id, id);
}
