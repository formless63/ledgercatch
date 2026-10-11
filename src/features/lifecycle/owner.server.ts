/** Ownership guards shared by lifecycle server modules. */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import {
	documents,
	entities,
	orderItems,
	orders,
} from "#/features/ledger/schema";

export async function assertOwnedOrder(ownerId: string, orderId: string) {
	const [row] = await db
		.select({ id: orders.id })
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row.id;
}

/** Item plus its order, only if the order belongs to the owner. */
export async function findOwnedItem(ownerId: string, itemId: string) {
	const [row] = await db
		.select({
			id: orderItems.id,
			orderId: orderItems.orderId,
			title: orderItems.title,
			sku: orderItems.sku,
			entityId: orderItems.entityId,
			orderEntityId: orders.entityId,
			orderDate: orders.orderDate,
		})
		.from(orderItems)
		.innerJoin(orders, eq(orders.id, orderItems.orderId))
		.where(and(eq(orderItems.id, itemId), eq(orders.ownerId, ownerId)));
	return row ?? null;
}

export async function assertOwnedEntity(
	ownerId: string,
	entityId: string | null | undefined,
) {
	if (!entityId) return;
	const [row] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.id, entityId), eq(entities.ownerId, ownerId)));
	if (!row) throw new Error("Unknown entity");
}

export async function assertOwnedDocuments(
	ownerId: string,
	documentIds: string[],
) {
	if (documentIds.length === 0) return;
	const rows = await db
		.select({ id: documents.id })
		.from(documents)
		.where(
			and(eq(documents.ownerId, ownerId), inArray(documents.id, documentIds)),
		);
	if (rows.length !== new Set(documentIds).size)
		throw new Error("Unknown document");
}
