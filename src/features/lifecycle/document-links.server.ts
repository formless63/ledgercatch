/**
 * One document, several orders (risk 9: AliExpress combined invoices).
 * `documents.order_id` remains the primary link; `document_links` adds more.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "#/db";
import { findOwnedDocument } from "#/features/ledger/ledger.server";
import { audit } from "#/features/ledger/orders.server";
import { documents } from "#/features/ledger/schema";
import { assertOwnedOrder } from "./owner.server";
import { documentLinks } from "./schema";

/**
 * Link a document to an order. Without a primary link it becomes the
 * primary (documents.order_id); otherwise an extra link row is added.
 */
export async function linkDocumentToOrderForOwner(
	ownerId: string,
	documentId: string,
	orderId: string,
) {
	const doc = await findOwnedDocument(ownerId, documentId);
	if (!doc) throw new Error("NOT_FOUND");
	await assertOwnedOrder(ownerId, orderId);
	if (doc.orderId === orderId) return { ok: true, primary: true };
	return db.transaction(async (tx) => {
		const actor = { type: "user" as const, id: ownerId };
		if (!doc.orderId) {
			await tx
				.update(documents)
				.set({ orderId })
				.where(eq(documents.id, doc.id));
			await audit(tx, actor, "order.document_linked", orderId, {
				documentId: doc.id,
				fileName: doc.fileName,
				primary: true,
			});
			return { ok: true, primary: true };
		}
		await tx
			.insert(documentLinks)
			.values({ documentId: doc.id, orderId })
			.onConflictDoNothing();
		await audit(tx, actor, "order.document_linked", orderId, {
			documentId: doc.id,
			fileName: doc.fileName,
			primary: false,
			primaryOrderId: doc.orderId,
		});
		return { ok: true, primary: false };
	});
}

/** Remove an extra link (primary links are managed by attachDocumentToOrder). */
export async function unlinkDocumentFromOrderForOwner(
	ownerId: string,
	documentId: string,
	orderId: string,
) {
	const doc = await findOwnedDocument(ownerId, documentId);
	if (!doc) throw new Error("NOT_FOUND");
	await db.transaction(async (tx) => {
		const removed = await tx
			.delete(documentLinks)
			.where(
				and(
					eq(documentLinks.documentId, doc.id),
					eq(documentLinks.orderId, orderId),
				),
			)
			.returning({ orderId: documentLinks.orderId });
		if (removed.length)
			await audit(
				tx,
				{ type: "user", id: ownerId },
				"order.document_unlinked",
				orderId,
				{ documentId: doc.id, fileName: doc.fileName },
			);
	});
	return { ok: true };
}

/** Documents linked to an order through extra links (not the primary). */
export async function listLinkedDocumentsForOwner(
	ownerId: string,
	orderId: string,
) {
	await assertOwnedOrder(ownerId, orderId);
	const rows = await db
		.select({
			id: documents.id,
			kind: documents.kind,
			fileName: documents.fileName,
			contentType: documents.contentType,
			sizeBytes: documents.sizeBytes,
			primaryOrderId: documents.orderId,
			createdAt: documents.createdAt,
		})
		.from(documentLinks)
		.innerJoin(documents, eq(documents.id, documentLinks.documentId))
		.where(
			and(eq(documentLinks.orderId, orderId), eq(documents.ownerId, ownerId)),
		)
		.orderBy(desc(documents.createdAt));
	return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
