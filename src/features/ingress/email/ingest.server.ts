/**
 * One raw email (IMAP poll, inbound webhook, upload) → stored .eml +
 * attachment documents + ONE capture (channel "email", kind "email").
 * Parsing happens later in the captures.process job (email/parse.server.ts).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "#/db";
import { storeDocument } from "#/features/ledger/documents.server";
import { captures, documents } from "#/features/ledger/schema";
import { getLogger } from "#/integrations/observability/runtime.server";
import type { DocumentKind } from "#/shared/capture";
import { MAX_DOCUMENT_BYTES } from "#/shared/capture";
import { createServerCapture } from "../captures.server";
import {
	MAX_EMAIL_BYTES,
	type MimeAttachment,
	parseMimeMessage,
} from "./mime.server";
import type { EmailCaptureBody } from "./types";

export type EmailChannelMeta = {
	via: "imap" | "webhook" | "upload";
	sourceId?: string;
	mailbox?: string;
	uid?: number;
};

export type IngestEmailResult = {
	captureId: string;
	created: boolean;
	messageId: string;
	source: string;
	subject: string;
};

/** HTML kept in body_json only when small; body_text always has it. */
const MAX_JSON_HTML_CHARS = 1024 * 1024;

const STORABLE = /^(application\/pdf|image\/(png|jpeg|webp))$/;

export function attachmentKind(
	fileName: string,
	contentType: string,
): DocumentKind {
	const name = fileName.toLowerCase();
	if (/packing[\s_-]*(slip|list)|lieferschein/.test(name))
		return "packing_slip";
	if (/invoice|rechnung|factur|faktura|fattura|\binv[\s_-]?\d/.test(name))
		return "invoice";
	if (/receipt|quittung|beleg|recibo/.test(name)) return "receipt";
	return contentType.startsWith("image/") ? "receipt" : "other";
}

function safeBase(subject: string): string {
	return (
		subject
			.replace(/[^\w.\- ()]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80) || "email"
	);
}

function storableAttachments(list: MimeAttachment[]): MimeAttachment[] {
	return list.filter(
		(a) =>
			STORABLE.test(a.contentType) &&
			a.size > 0 &&
			a.size <= MAX_DOCUMENT_BYTES &&
			// Inline images are logos/pixels; PDFs are kept even when inline.
			(!a.inline || a.contentType === "application/pdf"),
	);
}

export async function ingestRawEmail(
	ownerId: string,
	rawMime: Uint8Array,
	channelMeta: EmailChannelMeta,
): Promise<IngestEmailResult> {
	if (rawMime.byteLength === 0) throw new Error("Empty email");
	if (rawMime.byteLength > MAX_EMAIL_BYTES)
		throw new Error(
			`Email is larger than ${MAX_EMAIL_BYTES / 1024 / 1024} MB; skipped`,
		);
	const mime = await parseMimeMessage(rawMime);
	const rawHash = createHash("sha256").update(rawMime).digest("hex");
	const sourceRef = (mime.messageId || `sha256:${rawHash}`).slice(0, 900);

	// Cheap idempotency check before touching object storage.
	const [existing] = await db
		.select({ id: captures.id })
		.from(captures)
		.where(
			and(
				eq(captures.ownerId, ownerId),
				eq(captures.channel, "email"),
				eq(captures.sourceRef, sourceRef),
			),
		);
	if (existing)
		return {
			captureId: existing.id,
			created: false,
			messageId: mime.messageId,
			source: mime.source,
			subject: mime.subject,
		};

	const ref = mime.messageId || rawHash;
	const originUrl = `email:${ref}`.slice(0, 2000);
	let emlDocumentId: string | null = null;
	try {
		const stored = await storeDocument({
			ownerId,
			bytes: rawMime,
			contentType: "message/rfc822",
			fileName: `${safeBase(mime.subject)}.eml`,
			kind: "other",
			source: mime.source,
			originUrl,
		});
		emlDocumentId = stored.id;
	} catch (error) {
		// Storage outages must not lose the email: body_json still has it.
		getLogger().warn({ err: error }, "ingress.email: could not store .eml");
	}

	const attachmentDocs: EmailCaptureBody["attachments"] = [];
	for (const attachment of storableAttachments(mime.attachments)) {
		try {
			const stored = await storeDocument({
				ownerId,
				bytes: attachment.content,
				contentType: attachment.contentType,
				fileName: attachment.fileName,
				kind: attachmentKind(attachment.fileName, attachment.contentType),
				source: mime.source,
				originUrl,
			});
			attachmentDocs.push({
				documentId: stored.id,
				fileName: attachment.fileName,
				contentType: attachment.contentType,
				size: attachment.size,
			});
		} catch (error) {
			getLogger().warn(
				{ err: error, fileName: attachment.fileName },
				"ingress.email: could not store attachment",
			);
		}
	}

	const body: EmailCaptureBody = {
		version: 1,
		from: mime.from,
		to: mime.to,
		subject: mime.subject,
		date: mime.date ?? null,
		messageId: mime.messageId,
		html:
			mime.html && mime.html.length <= MAX_JSON_HTML_CHARS ? mime.html : null,
		text: mime.text ?? null,
		attachments: attachmentDocs,
		forwarded: mime.forwarded ?? null,
		channel: channelMeta,
	};
	const capturedAt = mime.date ? new Date(mime.date) : new Date();
	const { captureId, created } = await createServerCapture({
		ownerId,
		channel: "email",
		sourceRef,
		source: mime.source,
		kind: "email",
		pageType: "unknown",
		pageUrl: originUrl,
		pageTitle: mime.subject,
		capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt,
		bodyText: mime.html ?? mime.text ?? null,
		bodyJson: body,
		documentId: emlDocumentId,
		note: mime.forwarded
			? `Forwarded by ${mime.forwarded.by?.address ?? "unknown"}`
			: null,
	});

	const docIds = [
		...(emlDocumentId ? [emlDocumentId] : []),
		...attachmentDocs.map((a) => a.documentId),
	];
	if (created && docIds.length)
		await db
			.update(documents)
			.set({ captureId })
			.where(
				and(
					eq(documents.ownerId, ownerId),
					inArray(documents.id, docIds),
					isNull(documents.captureId),
				),
			);
	return {
		captureId,
		created,
		messageId: mime.messageId,
		source: mime.source,
		subject: mime.subject,
	};
}
