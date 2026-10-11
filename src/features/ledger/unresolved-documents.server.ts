import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { publishLedgerEvent } from "./events.server";
import { captures, documents } from "./schema";

/** Expose an unknown Mouser invoice/order mapping in the existing assisted review queue. */
export async function queueUnresolvedMouserInvoiceForOwner(
	ownerId: string,
	documentId: string,
): Promise<string | null> {
	const result = await db.transaction(async (tx) => {
		const [document] = await tx
			.select()
			.from(documents)
			.where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)))
			.for("update");
		if (!document) throw new Error("NOT_FOUND");
		if (
			document.orderId ||
			document.externalOrderId ||
			document.source !== "mouser" ||
			document.kind !== "invoice" ||
			document.contentType !== "application/pdf"
		)
			return null;
		const [existing] = await tx
			.select({ id: captures.id })
			.from(captures)
			.where(
				and(
					eq(captures.ownerId, ownerId),
					eq(captures.kind, "document"),
					eq(captures.documentId, document.id),
				),
			)
			.limit(1);
		if (existing) return { captureId: existing.id, created: false };
		const captureId = randomUUID();
		const reason =
			"Mouser invoice saved without an order match. Its invoice number is not a Web Order number. Use Attach to choose the matching order.";
		const sourceRef = `mouser-invoice-review:${document.id}`;
		await tx.insert(captures).values({
			id: captureId,
			ownerId,
			source: "mouser",
			kind: "document",
			trigger: "passive",
			pageType: "invoice",
			pageUrl: document.originUrl ?? `document:${document.id}`,
			pageTitle: document.fileName,
			capturedAt: document.createdAt,
			contentHash: createHash("sha256").update(sourceRef).digest("hex"),
			channel: "extension",
			sourceRef,
			documentId: document.id,
			status: "needs_review",
			error: reason,
			bodyJson: { hints: { merchant: "Mouser Electronics" } },
		});
		await tx
			.update(documents)
			.set({ captureId })
			.where(
				and(eq(documents.id, document.id), eq(documents.ownerId, ownerId)),
			);
		// No parsing job: the invoice URL contains an invoice number, not an order ID.
		return { captureId, created: true };
	});
	if (result?.created)
		publishLedgerEvent(ownerId, {
			type: "capture",
			captureId: result.captureId,
		});
	return result?.captureId ?? null;
}
