/** Latest parser support is separate from immutable historical provenance. */
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { assets, documentLinks, refunds } from "#/features/lifecycle/schema";
import { transactionMatches } from "#/features/money/schema";
import { listParsers } from "#/features/parsing/registry";
import { publishLedgerEvent } from "./events.server";
import { audit, type Tx } from "./orders.server";
import {
	allocations,
	captures,
	documents,
	exports,
	orderCaptures,
	orderItems,
	orders,
} from "./schema";

/** NULL historical links, failed parses and pending reparses never prove absence. */
function unsupportedOrderForOwner(ownerId: string) {
	const versions = sql.join(
		listParsers().map(
			(parser) => sql`(${parser.source}, ${parser.version}::integer)`,
		),
		sql`, `,
	);
	return sql<boolean>`
		exists (
			select 1 from ${orderCaptures} oc
			join ${captures} c on c.id = oc.capture_id
			where oc.order_id = "orders"."id" and c.owner_id = ${ownerId}
		)
		and not exists (
			select 1 from ${orderCaptures} oc
			join ${captures} c on c.id = oc.capture_id
			where oc.order_id = "orders"."id" and (
				c.owner_id <> ${ownerId}
				or oc.supported_by_parser is distinct from false
				or c.status not in ('parsed', 'no_orders')
				or not exists (
					select 1 from (values ${versions}) cp(parser_id, version)
					where cp.parser_id = c.parser_id and c.parser_version = cp.version
				)
			)
		)`;
}

/** Called inside the parse transaction before emitted orders restore their support. */
export async function resetCaptureSupportForOwner(
	tx: Tx,
	ownerId: string,
	captureId: string,
) {
	// Serialize parse results for a capture; support and capture status commit together.
	const [capture] = await tx
		.select({ id: captures.id })
		.from(captures)
		.where(and(eq(captures.id, captureId), eq(captures.ownerId, ownerId)))
		.for("update");
	if (!capture) throw new Error("NOT_FOUND");
	await tx
		.update(orderCaptures)
		.set({ supportedByParser: false })
		.where(
			and(
				eq(orderCaptures.captureId, captureId),
				sql`exists (select 1 from ${orders} o where o.id = ${orderCaptures.orderId} and o.owner_id = ${ownerId})`,
			),
		);
}

export async function listUnsupportedOrdersForOwner(ownerId: string) {
	return db
		.select({
			id: orders.id,
			source: orders.source,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			totalMinor: orders.totalMinor,
			currency: orders.currency,
			total: sql<number>`count(*) over()`.mapWith(Number),
		})
		.from(orders)
		.where(and(eq(orders.ownerId, ownerId), unsupportedOrderForOwner(ownerId)))
		.orderBy(orders.firstSeenAt, orders.id)
		.limit(100);
}

/** Human-approved removal only; retain captures and refuse accounting history loss. */
export async function deleteUnsupportedOrderForOwner(
	ownerId: string,
	orderId: string,
) {
	await db.transaction(async (tx) => {
		const [order] = await tx
			.select({ id: orders.id })
			.from(orders)
			.where(and(eq(orders.ownerId, ownerId), eq(orders.id, orderId)))
			.for("update");
		if (!order) throw new Error("NOT_FOUND");
		// Prevent indirect asset inserts and existing allocation state changes
		// from racing the history guards below. New direct links wait on the order.
		await tx
			.select({ id: orderItems.id })
			.from(orderItems)
			.innerJoin(orders, eq(orders.id, orderItems.orderId))
			.where(and(eq(orders.ownerId, ownerId), eq(orders.id, orderId)))
			.for("update", { of: orderItems });
		await tx
			.select({ id: allocations.id })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(eq(orders.ownerId, ownerId), eq(orders.id, orderId)))
			.for("update", { of: allocations });
		const [unsupported] = await tx
			.select({ id: orders.id })
			.from(orders)
			.where(
				and(
					eq(orders.ownerId, ownerId),
					eq(orders.id, orderId),
					unsupportedOrderForOwner(ownerId),
				),
			);
		if (!unsupported)
			throw new Error(
				"This order still has parser support or an unchecked capture.",
			);
		const [claimed] = await tx
			.select({ id: allocations.id })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(
				and(
					eq(orders.ownerId, ownerId),
					eq(orders.id, orderId),
					sql`(${allocations.claimId} is not null or ${allocations.reimbursementStatus} in ('submitted', 'reimbursed'))`,
				),
			)
			.limit(1);
		if (claimed)
			throw new Error(
				"This order has a reimbursement claim or payment history. Resolve it before deleting.",
			);
		const [exported] = await tx
			.select({ id: exports.id })
			.from(exports)
			.innerJoin(orders, eq(orders.id, exports.orderId))
			.where(and(eq(orders.ownerId, ownerId), eq(orders.id, orderId)))
			.limit(1);
		if (exported)
			throw new Error(
				"This order has accounting export history. Merge it into the real order instead.",
			);
		const [history] = await tx
			.select({ id: orders.id })
			.from(orders)
			.where(
				and(
					eq(orders.ownerId, ownerId),
					eq(orders.id, orderId),
					sql`(
				exists (select 1 from ${assets} a where a.owner_id = ${ownerId} and (
					a.order_id = "orders"."id"
					or exists (select 1 from ${orderItems} i where i.id = a.order_item_id and i.order_id = "orders"."id")
				))
				or exists (select 1 from ${refunds} r where r.order_id = "orders"."id" and r.owner_id = ${ownerId})
				or exists (select 1 from ${transactionMatches} m where m.order_id = "orders"."id" and m.owner_id = ${ownerId})
				or exists (select 1 from ${documents} d where d.order_id = "orders"."id" and d.owner_id = ${ownerId})
				or exists (select 1 from ${documentLinks} l join ${documents} d on d.id = l.document_id where l.order_id = "orders"."id" and d.owner_id = ${ownerId})
			)`,
				),
			);
		if (history)
			throw new Error(
				"This order has documents, assets, refunds or statement matches. Merge it into the real order instead.",
			);
		await audit(tx, { type: "user", id: ownerId }, "order.deleted", orderId, {
			reason: "no_current_capture_support",
		});
		await tx
			.delete(orders)
			.where(and(eq(orders.ownerId, ownerId), eq(orders.id, orderId)));
	});
	publishLedgerEvent(ownerId, {
		type: "orders",
		orderIds: [orderId],
		created: 0,
	});
	return { deleted: orderId };
}
