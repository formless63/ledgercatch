/**
 * Refunds, returns and cancellations (#10): CRUD, parser bridge and the
 * refunds-aware net-spend / claim helpers used by insights and claims.
 */
import {
	and,
	asc,
	eq,
	gte,
	inArray,
	isNotNull,
	lte,
	type SQL,
	sql,
} from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { audit, type Tx } from "#/features/ledger/orders.server";
import {
	allocations,
	claims,
	exports,
	orderItems,
	orders,
} from "#/features/ledger/schema";
import type {
	netSpendInput,
	refundCreateInput,
	refundUpdateInput,
} from "./inputs";
import { assertOwnedDocuments, assertOwnedOrder } from "./owner.server";
import {
	type ClaimDecision,
	claimDecision,
	type NetAllocation,
	netAllocations,
	type ParsedRefund,
	type RefundInput,
} from "./refunds";
import { refunds } from "./schema";

const user = (id: string) => ({ type: "user" as const, id });

/* ───────────────────────── downstream flags ───────────────────────── */

/**
 * A refund changes what an order really cost: flag sent exports as stale and
 * mark claims holding this order's allocations as changed.
 */
async function flagDownstream(tx: Tx, orderId: string) {
	await tx
		.update(exports)
		.set({ status: "stale", error: "Refund recorded after export" })
		.where(and(eq(exports.orderId, orderId), eq(exports.status, "sent")));
	const claimed = await tx
		.select({ claimId: allocations.claimId })
		.from(allocations)
		.where(
			and(eq(allocations.orderId, orderId), isNotNull(allocations.claimId)),
		);
	const ids = [...new Set(claimed.map((r) => r.claimId as string))];
	if (ids.length)
		await tx
			.update(claims)
			.set({ amountChangedAt: new Date() })
			.where(inArray(claims.id, ids));
}

/* ───────────────────────── per-order view ───────────────────────── */

async function loadOrderRefundContext(orderIds: string[]) {
	if (orderIds.length === 0)
		return { allocs: [], refundRows: [], items: [], orderRows: [] };
	const [allocs, refundRows, items, orderRows] = await Promise.all([
		db
			.select({
				id: allocations.id,
				orderId: allocations.orderId,
				entityId: allocations.entityId,
				amountMinor: allocations.amountMinor,
				currency: allocations.currency,
			})
			.from(allocations)
			.where(inArray(allocations.orderId, orderIds)),
		db.select().from(refunds).where(inArray(refunds.orderId, orderIds)),
		db
			.select({
				id: orderItems.id,
				orderId: orderItems.orderId,
				entityId: orderItems.entityId,
			})
			.from(orderItems)
			.where(inArray(orderItems.orderId, orderIds)),
		db
			.select({
				id: orders.id,
				entityId: orders.entityId,
				status: orders.status,
			})
			.from(orders)
			.where(inArray(orders.id, orderIds)),
	]);
	return { allocs, refundRows, items, orderRows };
}

function groupBy<T, K>(rows: T[], key: (row: T) => K) {
	const map = new Map<K, T[]>();
	for (const row of rows)
		map.set(key(row), [...(map.get(key(row)) ?? []), row]);
	return map;
}

/** Net allocations for many orders (owner already verified by caller). */
export async function netAllocationsForOrders(
	orderIds: string[],
): Promise<Map<string, NetAllocation[]>> {
	const ctx = await loadOrderRefundContext(orderIds);
	const allocByOrder = groupBy(ctx.allocs, (r) => r.orderId);
	const refundsByOrder = groupBy(ctx.refundRows, (r) => r.orderId);
	const itemsByOrder = groupBy(ctx.items, (r) => r.orderId);
	const out = new Map<string, NetAllocation[]>();
	for (const order of ctx.orderRows) {
		out.set(
			order.id,
			netAllocations({
				allocations: allocByOrder.get(order.id) ?? [],
				refunds: (refundsByOrder.get(order.id) ?? []) as RefundInput[],
				items: itemsByOrder.get(order.id) ?? [],
				primaryEntityId: order.entityId,
			}),
		);
	}
	return out;
}

export async function listRefundsForOwner(ownerId: string, orderId: string) {
	await assertOwnedOrder(ownerId, orderId);
	const rows = await db
		.select()
		.from(refunds)
		.where(and(eq(refunds.orderId, orderId), eq(refunds.ownerId, ownerId)))
		.orderBy(asc(refunds.createdAt));
	const net = (await netAllocationsForOrders([orderId])).get(orderId) ?? [];
	return {
		refunds: rows.map((r) => ({
			...r,
			createdAt: r.createdAt.toISOString(),
			updatedAt: r.updatedAt.toISOString(),
		})),
		allocations: net,
		refundedMinor: net.reduce((s, a) => s + a.refundedMinor, 0),
		pendingRefundMinor: net.reduce((s, a) => s + a.pendingRefundMinor, 0),
	};
}
export type OrderRefunds = Awaited<ReturnType<typeof listRefundsForOwner>>;

/* ───────────────────────── mutations ───────────────────────── */

async function assertOrderItem(
	orderId: string,
	itemId: string | null | undefined,
) {
	if (!itemId) return;
	const [row] = await db
		.select({ id: orderItems.id })
		.from(orderItems)
		.where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
	if (!row) throw new Error("Unknown order item");
}

export async function createRefundForOwner(
	ownerId: string,
	input: z.output<typeof refundCreateInput>,
) {
	await assertOwnedOrder(ownerId, input.orderId);
	await assertOrderItem(input.orderId, input.orderItemId);
	if (input.documentId) await assertOwnedDocuments(ownerId, [input.documentId]);
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(refunds)
			.values({
				ownerId,
				orderId: input.orderId,
				orderItemId: input.orderItemId ?? null,
				amountMinor: input.amountMinor,
				currency: input.currency,
				reason: input.reason ?? null,
				status: input.status,
				refundedAt:
					input.refundedAt ??
					(input.status === "refunded"
						? new Date().toISOString().slice(0, 10)
						: null),
				documentId: input.documentId ?? null,
				origin: "manual",
			})
			.returning({ id: refunds.id });
		if (!row) throw new Error("Refund insert failed");
		await audit(tx, user(ownerId), "order.refund_recorded", input.orderId, {
			refundId: row.id,
			amountMinor: input.amountMinor,
			currency: input.currency,
			status: input.status,
		});
		if (input.status === "refunded") await flagDownstream(tx, input.orderId);
		return { id: row.id };
	});
}

async function ownedRefund(ownerId: string, id: string) {
	const [row] = await db
		.select()
		.from(refunds)
		.where(and(eq(refunds.id, id), eq(refunds.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

export async function updateRefundForOwner(
	ownerId: string,
	input: z.output<typeof refundUpdateInput>,
) {
	const current = await ownedRefund(ownerId, input.id);
	const status = input.status ?? current.status;
	await db.transaction(async (tx) => {
		await tx
			.update(refunds)
			.set({
				status,
				...(input.amountMinor !== undefined
					? { amountMinor: input.amountMinor }
					: {}),
				...(input.reason !== undefined ? { reason: input.reason } : {}),
				refundedAt:
					input.refundedAt !== undefined
						? input.refundedAt
						: status === "refunded" && !current.refundedAt
							? new Date().toISOString().slice(0, 10)
							: current.refundedAt,
				updatedAt: new Date(),
			})
			.where(eq(refunds.id, current.id));
		await audit(tx, user(ownerId), "order.refund_updated", current.orderId, {
			refundId: current.id,
			from: current.status,
			to: status,
		});
		if (status === "refunded" || current.status === "refunded")
			await flagDownstream(tx, current.orderId);
	});
	return { ok: true };
}

export async function deleteRefundForOwner(ownerId: string, id: string) {
	const current = await ownedRefund(ownerId, id);
	await db.transaction(async (tx) => {
		await tx.delete(refunds).where(eq(refunds.id, current.id));
		await audit(tx, user(ownerId), "order.refund_removed", current.orderId, {
			refundId: current.id,
			amountMinor: current.amountMinor,
		});
		if (current.status === "refunded")
			await flagDownstream(tx, current.orderId);
	});
	return { ok: true };
}

/* ───────────────────────── parser bridge ───────────────────────── */

/**
 * Record (or update) a refund reported by a parser or email ingester, inside
 * the caller's transaction (typically right after upsertParsedOrder).
 * Idempotent on (order, externalRefundId); without an id, on
 * (order, capture, amount). Status only moves forward.
 */
export async function recordRefundFromParsed(
	tx: Tx,
	input: {
		ownerId: string;
		orderId: string;
		refund: ParsedRefund;
		captureId?: string | null;
		origin?: "parser" | "email" | "import";
		/** Order currency fallback. */
		currency?: string | null;
	},
): Promise<{ refundId: string; created: boolean } | null> {
	const { refund } = input;
	if (!(refund.amountMinor > 0)) return null;
	const currency = (refund.currency ?? input.currency ?? "USD").toUpperCase();
	const status = refund.status ?? "requested";

	let orderItemId: string | null = null;
	if (refund.itemExternalId || refund.itemSku) {
		const match: SQL[] = [eq(orderItems.orderId, input.orderId)];
		match.push(
			refund.itemExternalId
				? eq(orderItems.externalItemId, refund.itemExternalId)
				: eq(orderItems.sku, refund.itemSku as string),
		);
		const [item] = await tx
			.select({ id: orderItems.id })
			.from(orderItems)
			.where(and(...match))
			.limit(1);
		orderItemId = item?.id ?? null;
	}

	const where: SQL[] = [eq(refunds.orderId, input.orderId)];
	if (refund.externalRefundId)
		where.push(eq(refunds.externalRefundId, refund.externalRefundId));
	else {
		if (!input.captureId) where.push(sql`false`);
		else where.push(eq(refunds.captureId, input.captureId));
		where.push(eq(refunds.amountMinor, refund.amountMinor));
	}
	const [existing] = await tx
		.select()
		.from(refunds)
		.where(and(...where))
		.limit(1);

	const rank = { requested: 0, approved: 1, refunded: 2 } as const;
	if (existing) {
		const nextStatus =
			rank[status] > rank[existing.status] ? status : existing.status;
		const changed =
			nextStatus !== existing.status ||
			existing.amountMinor !== refund.amountMinor;
		if (changed) {
			await tx
				.update(refunds)
				.set({
					status: nextStatus,
					amountMinor: refund.amountMinor,
					refundedAt: refund.refundedAt ?? existing.refundedAt,
					reason: refund.reason ?? existing.reason,
					updatedAt: new Date(),
				})
				.where(eq(refunds.id, existing.id));
			await audit(
				tx,
				{ type: "system", id: input.origin ?? "parser" },
				"order.refund_updated",
				input.orderId,
				{ refundId: existing.id, from: existing.status, to: nextStatus },
			);
			if (nextStatus === "refunded") await flagDownstream(tx, input.orderId);
		}
		return { refundId: existing.id, created: false };
	}

	const [row] = await tx
		.insert(refunds)
		.values({
			ownerId: input.ownerId,
			orderId: input.orderId,
			orderItemId,
			amountMinor: refund.amountMinor,
			currency,
			reason: refund.reason?.slice(0, 500) ?? null,
			status,
			refundedAt: refund.refundedAt ?? null,
			origin: input.origin ?? "parser",
			externalRefundId: refund.externalRefundId ?? null,
			captureId: input.captureId ?? null,
		})
		.onConflictDoNothing()
		.returning({ id: refunds.id });
	if (!row) return null;
	await audit(
		tx,
		{ type: "system", id: input.origin ?? "parser" },
		"order.refund_recorded",
		input.orderId,
		{ refundId: row.id, amountMinor: refund.amountMinor, currency, status },
	);
	if (status === "refunded") await flagDownstream(tx, input.orderId);
	return { refundId: row.id, created: true };
}

/* ───────────────────── net spend (insights) ───────────────────── */

/**
 * Allocation spend net of refunds, per entity and currency (and per month).
 * Same order filter as insights: not ignored. Cancelled orders are kept here
 * (unlike gross insights) so a cancellation without a recorded refund still
 * shows; pass the result's `cancelledGrossMinor` if you want to hide them.
 */
export async function getNetSpendForOwner(
	ownerId: string,
	input: z.output<typeof netSpendInput>,
) {
	const where: SQL[] = [
		eq(orders.ownerId, ownerId),
		sql`${orders.reviewState} <> 'ignored'`,
	];
	if (input.from) where.push(gte(orders.orderDate, input.from));
	if (input.to) where.push(lte(orders.orderDate, input.to));
	const orderRows = await db
		.select({
			id: orders.id,
			orderDate: orders.orderDate,
			status: orders.status,
		})
		.from(orders)
		.innerJoin(allocations, eq(allocations.orderId, orders.id))
		.where(and(...where))
		.groupBy(orders.id);
	const byOrder = new Map(orderRows.map((o) => [o.id, o]));
	const ids = orderRows.map((o) => o.id);
	const net = new Map<string, NetAllocation[]>();
	for (let i = 0; i < ids.length; i += 1000) {
		for (const [k, v] of await netAllocationsForOrders(ids.slice(i, i + 1000)))
			net.set(k, v);
	}
	type Bucket = {
		entityId: string;
		currency: string;
		grossMinor: number;
		refundedMinor: number;
		pendingRefundMinor: number;
		netMinor: number;
		cancelledGrossMinor: number;
	};
	const byEntity = new Map<string, Bucket>();
	const byMonth = new Map<string, Bucket & { month: string }>();
	const add = (bucket: Bucket, a: NetAllocation, cancelled: boolean) => {
		bucket.grossMinor += a.amountMinor;
		bucket.refundedMinor += a.refundedMinor;
		bucket.pendingRefundMinor += a.pendingRefundMinor;
		bucket.netMinor += a.netMinor;
		if (cancelled) bucket.cancelledGrossMinor += a.amountMinor;
	};
	const empty = (entityId: string, currency: string): Bucket => ({
		entityId,
		currency,
		grossMinor: 0,
		refundedMinor: 0,
		pendingRefundMinor: 0,
		netMinor: 0,
		cancelledGrossMinor: 0,
	});
	for (const [orderId, list] of net) {
		const order = byOrder.get(orderId);
		const month = order?.orderDate?.slice(0, 7) ?? "unknown";
		const cancelled = order?.status === "cancelled";
		for (const a of list) {
			if (input.entityId && a.entityId !== input.entityId) continue;
			const ek = `${a.entityId}|${a.currency}`;
			const eb = byEntity.get(ek) ?? empty(a.entityId, a.currency);
			add(eb, a, cancelled);
			byEntity.set(ek, eb);
			const mk = `${month}|${ek}`;
			const mb = byMonth.get(mk) ?? { ...empty(a.entityId, a.currency), month };
			add(mb, a, cancelled);
			byMonth.set(mk, mb);
		}
	}
	return {
		byEntity: [...byEntity.values()],
		byMonthEntity: [...byMonth.values()].sort((a, b) =>
			a.month.localeCompare(b.month),
		),
	};
}

/* ───────────────────── reimbursement claims ───────────────────── */

/**
 * For createClaim: which of these allocations may still be claimed and for
 * how much (net of refunds). Call it before inserting the claim, drop the
 * non-claimable ids and use `claimMinor` instead of `amountMinor` for the
 * claim total. Allocations not owned by `ownerId` are omitted.
 */
export async function claimableAllocationsForOwner(
	ownerId: string,
	allocationIds: string[],
): Promise<Map<string, ClaimDecision>> {
	if (allocationIds.length === 0) return new Map();
	const owned = await db
		.select({
			id: allocations.id,
			orderId: allocations.orderId,
			status: orders.status,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(
			and(eq(orders.ownerId, ownerId), inArray(allocations.id, allocationIds)),
		);
	const orderIds = [...new Set(owned.map((r) => r.orderId))];
	const net = await netAllocationsForOrders(orderIds);
	const statusByOrder = new Map(owned.map((r) => [r.orderId, r.status]));
	const out = new Map<string, ClaimDecision>();
	for (const [orderId, list] of net) {
		for (const a of list) {
			if (!allocationIds.includes(a.id)) continue;
			out.set(a.id, claimDecision(a, statusByOrder.get(orderId) ?? "unknown"));
		}
	}
	return out;
}
