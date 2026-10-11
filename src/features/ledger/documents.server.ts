import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { getApplicationStorage } from "#/lib/storage.server";
import type {
	CaptureEnvelope,
	DocumentKind,
	DocumentUploadMeta,
	StoreId,
} from "#/shared/capture";
import { afterDocument } from "./outbound.server";
import { documents, orders } from "./schema";
import { queueUnresolvedMouserInvoiceForOwner } from "./unresolved-documents.server";

const ALLOWED_CONTENT_TYPES = new Set([
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/webp",
	"text/html",
	"text/plain",
	"text/csv",
	"message/rfc822",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/x-ofx",
]);

export function normalizeContentType(raw: string | null | undefined): string {
	const base = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	return ALLOWED_CONTENT_TYPES.has(base) ? base : "application/octet-stream";
}

function safeFileName(name: string): string {
	return (
		name
			.replace(/[^\w.\- ()]+/g, "_")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 200) || "document"
	);
}

export type StoredDocument = {
	id: string;
	duplicate: boolean;
	orderId: string | null;
};

/** Store bytes in object storage and record a document (deduplicated by sha256). */
export async function storeDocument(input: {
	ownerId: string;
	bytes: Uint8Array;
	contentType: string;
	fileName: string;
	kind: DocumentKind | "screenshot";
	source?: StoreId | null;
	externalOrderId?: string | null;
	orderId?: string | null;
	originUrl?: string | null;
	captureId?: string | null;
}): Promise<StoredDocument> {
	const sha256 = createHash("sha256").update(input.bytes).digest("hex");
	const existing = await db
		.select({ id: documents.id, orderId: documents.orderId })
		.from(documents)
		.where(
			and(eq(documents.ownerId, input.ownerId), eq(documents.sha256, sha256)),
		)
		.limit(1);
	if (existing[0])
		return {
			id: existing[0].id,
			duplicate: true,
			orderId: existing[0].orderId,
		};

	let orderId = input.orderId ?? null;
	if (!orderId && input.source && input.externalOrderId) {
		const match = await db
			.select({ id: orders.id })
			.from(orders)
			.where(
				and(
					eq(orders.ownerId, input.ownerId),
					eq(orders.source, input.source),
					eq(orders.externalOrderId, input.externalOrderId),
				),
			)
			.limit(1);
		orderId = match[0]?.id ?? null;
	}

	const storage = getApplicationStorage();
	const storageKey = storage.createKey(`documents/${input.ownerId}`);
	const contentType = normalizeContentType(input.contentType);
	await storage.putObject(storageKey, input.bytes, {
		contentType,
		contentLength: input.bytes.byteLength,
	});

	const [row] = await db
		.insert(documents)
		.values({
			ownerId: input.ownerId,
			orderId,
			source: input.source ?? null,
			externalOrderId: input.externalOrderId ?? null,
			kind: input.kind,
			fileName: safeFileName(input.fileName),
			contentType,
			sizeBytes: input.bytes.byteLength,
			sha256,
			storageKey,
			originUrl: input.originUrl ?? null,
			captureId: input.captureId ?? null,
		})
		.onConflictDoNothing()
		.returning({ id: documents.id });
	if (!row) {
		const again = await db
			.select({ id: documents.id, orderId: documents.orderId })
			.from(documents)
			.where(
				and(eq(documents.ownerId, input.ownerId), eq(documents.sha256, sha256)),
			)
			.limit(1);
		if (!again[0]) throw new Error("Document insert failed");
		return { id: again[0].id, duplicate: true, orderId: again[0].orderId };
	}
	void afterDocument(input.ownerId, row.id);
	return { id: row.id, duplicate: false, orderId };
}

export async function storeUploadedDocument(
	ownerId: string,
	meta: DocumentUploadMeta,
	bytes: Uint8Array,
	contentType: string,
) {
	const stored = await storeDocument({
		ownerId,
		bytes,
		contentType,
		fileName: meta.fileName,
		kind: meta.kind,
		source: meta.source,
		externalOrderId: meta.externalOrderId ?? null,
		originUrl: meta.originUrl ?? null,
		captureId: meta.captureId ?? null,
	});
	if (
		meta.source === "mouser" &&
		!meta.externalOrderId &&
		!stored.orderId &&
		meta.kind === "invoice" &&
		normalizeContentType(contentType) === "application/pdf"
	)
		await queueUnresolvedMouserInvoiceForOwner(ownerId, stored.id);
	return stored;
}

export async function storeScreenshot(
	ownerId: string,
	envelope: CaptureEnvelope,
	dataUrl: string,
): Promise<string | null> {
	const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
	if (!match?.[1] || !match[2]) return null;
	const bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
	const extension = match[1].split("/")[1] ?? "png";
	try {
		const stored = await storeDocument({
			ownerId,
			bytes,
			contentType: match[1],
			fileName: `capture-${envelope.captureId.slice(0, 8)}.${extension}`,
			kind: "screenshot",
			source: envelope.source,
			originUrl: envelope.pageUrl,
			captureId: envelope.captureId,
		});
		return stored.id;
	} catch {
		// Storage outages must not lose the capture itself.
		return null;
	}
}

/** Attach documents uploaded before their order existed. */
export async function linkPendingDocuments(
	ownerId: string,
	source: string,
	externalOrderId: string,
	orderId: string,
) {
	await db
		.update(documents)
		.set({ orderId })
		.where(
			and(
				eq(documents.ownerId, ownerId),
				eq(documents.source, source),
				eq(documents.externalOrderId, externalOrderId),
				isNull(documents.orderId),
			),
		);
}

export async function readDocumentBytes(
	storageKey: string,
): Promise<Uint8Array> {
	const object = await getApplicationStorage().getObject(storageKey);
	const body = object.body as
		| { transformToByteArray?: () => Promise<Uint8Array> }
		| undefined;
	if (!body?.transformToByteArray) throw new Error("Document body unavailable");
	return body.transformToByteArray();
}
