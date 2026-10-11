/**
 * Duplicate-order candidates, dismissals and merge (#6).
 */
import {
	and,
	eq,
	gte,
	inArray,
	isNotNull,
	lte,
	ne,
	or,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import { itemsSearchText } from "#/features/ledger/merge";
import { audit, recomputeAllocations } from "#/features/ledger/orders.server";
import {
	allocations,
	documents,
	exports,
	orderCaptures,
	orderItems,
	orders,
	shipments,
} from "#/features/ledger/schema";
import { transactionMatches } from "#/features/money/schema";
import {
	DATE_WINDOW_DAYS,
	type DuplicateSubject,
	detectDuplicates,
	pairKey,
	suggestKeep,
	TOTAL_TOLERANCE,
} from "./duplicates";
import {
	assets,
	documentLinks,
	orderDuplicateDismissals,
	refunds,
} from "./schema";

const subjectColumns = {
	id: orders.id,
	source: orders.source,
	externalOrderId: orders.externalOrderId,
	merchantName: orders.merchantName,
	orderDate: orders.orderDate,
	currency: orders.currency,
	totalMinor: orders.totalMinor,
	paymentMethodId: orders.paymentMethodId,
	reviewState: orders.reviewState,
	firstSeenAt: orders.firstSeenAt,
};

async function withItemTitles<T extends { id: string }>(rows: T[]) {
	if (rows.length === 0) return [];
	const items = await db
		.select({ orderId: orderItems.orderId, title: orderItems.title })
		.from(orderItems)
		.where(
			inArray(
				orderItems.orderId,
				rows.map((r) => r.id),
			),
		);
	const titles = new Map<string, string[]>();
	for (const item of items)
		titles.set(item.orderId, [...(titles.get(item.orderId) ?? []), item.title]);
	return rows.map((r) => ({ ...r, itemTitles: titles.get(r.id) ?? [] }));
}

async function dismissalsFor(ownerId: string, orderIds: string[]) {
	if (orderIds.length === 0) return [];
	const rows = await db
		.select({
			a: orderDuplicateDismissals.orderAId,
			b: orderDuplicateDismissals.orderBId,
		})
		.from(orderDuplicateDismissals)
		.where(
			and(
				eq(orderDuplicateDismissals.ownerId, ownerId),
				or(
					inArray(orderDuplicateDismissals.orderAId, orderIds),
					inArray(orderDuplicateDismissals.orderBId, orderIds),
				),
			),
		);
	return rows.map((r) => [r.a, r.b] as [string, string]);
}

const shiftDate = (iso: string, days: number) =>
	new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000)
		.toISOString()
		.slice(0, 10);

/** Orders near `focus` by date and total (SQL prefilter for the detector). */
async function neighbours(
	ownerId: string,
	focus: { id: string; orderDate: string; totalMinor: number },
) {
	const slack = Math.ceil(focus.totalMinor * TOTAL_TOLERANCE * 1.02) + 1;
	return db
		.select(subjectColumns)
		.from(orders)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				ne(orders.id, focus.id),
				ne(orders.reviewState, "ignored"),
				gte(orders.orderDate, shiftDate(focus.orderDate, -DATE_WINDOW_DAYS)),
				lte(orders.orderDate, shiftDate(focus.orderDate, DATE_WINDOW_DAYS)),
				gte(orders.totalMinor, focus.totalMinor - slack),
				lte(orders.totalMinor, focus.totalMinor + slack),
			),
		)
		.limit(50);
}

/** Candidates for one order (order detail / inspector). */
export async function getDuplicateCandidatesForOwner(
	ownerId: string,
	orderId: string,
) {
	const [focus] = await db
		.select(subjectColumns)
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!focus) throw new Error("NOT_FOUND");
	if (
		!focus.orderDate ||
		focus.totalMinor == null ||
		focus.reviewState === "ignored"
	)
		return [];
	const others = await neighbours(ownerId, {
		id: focus.id,
		orderDate: focus.orderDate,
		totalMinor: focus.totalMinor,
	});
	if (others.length === 0) return [];
	const subjects = await withItemTitles([focus, ...others]);
	const candidates = detectDuplicates({
		subjects,
		focusIds: [focus.id],
		dismissed: await dismissalsFor(ownerId, [focus.id]),
	});
	const byId = new Map(subjects.map((s) => [s.id, s]));
	return candidates.map((c) => {
		const otherId = c.orderId === focus.id ? c.otherId : c.orderId;
		const other = byId.get(otherId) as (typeof subjects)[number];
		const self = byId.get(focus.id) as (typeof subjects)[number];
		return {
			otherId,
			score: c.score,
			reasons: c.reasons,
			suggestedKeepId: suggestKeep(
				{ ...self, firstSeenAt: self.firstSeenAt.toISOString() },
				{ ...other, firstSeenAt: other.firstSeenAt.toISOString() },
			),
			other: {
				id: other.id,
				source: other.source,
				externalOrderId: other.externalOrderId,
				merchantName: other.merchantName,
				orderDate: other.orderDate,
				currency: other.currency,
				totalMinor: other.totalMinor,
				reviewState: other.reviewState,
				itemCount: other.itemTitles.length,
			},
		};
	});
}
export type DuplicateCandidateRow = Awaited<
	ReturnType<typeof getDuplicateCandidatesForOwner>
>[number];

/**
 * Which of these orders have at least one undismissed duplicate candidate
 * (inbox list chips). One query window covering all of them.
 */
export async function getDuplicateFlagsForOwner(
	ownerId: string,
	orderIds: string[],
): Promise<string[]> {
	if (orderIds.length === 0) return [];
	const focus = await db
		.select(subjectColumns)
		.from(orders)
		.where(and(eq(orders.ownerId, ownerId), inArray(orders.id, orderIds)));
	const dated = focus.filter((f) => f.orderDate && f.totalMinor != null);
	if (dated.length === 0) return [];
	const dates = dated.map((f) => f.orderDate as string).sort();
	const pool = await db
		.select(subjectColumns)
		.from(orders)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				ne(orders.reviewState, "ignored"),
				isNotNull(orders.totalMinor),
				gte(orders.orderDate, shiftDate(dates[0] as string, -DATE_WINDOW_DAYS)),
				lte(
					orders.orderDate,
					shiftDate(dates.at(-1) as string, DATE_WINDOW_DAYS),
				),
			),
		)
		.limit(5000);
	const subjects: DuplicateSubject[] = await withItemTitles(pool);
	const candidates = detectDuplicates({
		subjects,
		focusIds: orderIds,
		dismissed: await dismissalsFor(ownerId, orderIds),
	});
	const wanted = new Set(orderIds);
	const flagged = new Set<string>();
	for (const c of candidates) {
		if (wanted.has(c.orderId)) flagged.add(c.orderId);
		if (wanted.has(c.otherId)) flagged.add(c.otherId);
	}
	return [...flagged];
}

export async function dismissDuplicateForOwner(
	ownerId: string,
	orderId: string,
	otherId: string,
) {
	const owned = await db
		.select({ id: orders.id })
		.from(orders)
		.where(
			and(eq(orders.ownerId, ownerId), inArray(orders.id, [orderId, otherId])),
		);
	if (owned.length !== 2) throw new Error("NOT_FOUND");
	const [a, b] = pairKey(orderId, otherId);
	await db.transaction(async (tx) => {
		await tx
			.insert(orderDuplicateDismissals)
			.values({ ownerId, orderAId: a, orderBId: b })
			.onConflictDoNothing();
		await audit(
			tx,
			{ type: "user", id: ownerId },
			"order.duplicate_dismissed",
			orderId,
			{
				otherOrderId: otherId,
			},
		);
	});
	return { ok: true };
}

/**
 * Merge `dropId` into `keepId`: captures, documents (incl. extra links),
 * shipments, refunds and assets move over; items move only when the kept
 * order has none (both describe the same purchase, so appending would
 * double-count); empty fields on the kept order are filled from the dropped
 * one. Export history is re-pointed to the kept order and sent exports are
 * flagged stale (the remote may hold a duplicate expense). Refused while the
 * dropped order has allocations in a reimbursement claim. Statement matches,
 * submitted/reimbursed allocations on either side and inconsistent asset links
 * must be resolved before merging. Both orders get an
 * audit event; then the dropped order is deleted and allocations recomputed.
 */
export async function mergeOrdersForOwner(
	ownerId: string,
	keepId: string,
	dropId: string,
) {
	if (keepId === dropId) throw new Error("Cannot merge an order into itself");
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(orders)
			.where(
				and(eq(orders.ownerId, ownerId), inArray(orders.id, [keepId, dropId])),
			)
			.for("update");
		const keep = rows.find((r) => r.id === keepId);
		const drop = rows.find((r) => r.id === dropId);
		if (!keep || !drop) throw new Error("NOT_FOUND");
		// Order locks block new direct FK links. Lock line items as well so an
		// asset linked only through orderItemId cannot arrive after the guard.
		await tx
			.select({ id: orderItems.id })
			.from(orderItems)
			.innerJoin(orders, eq(orders.id, orderItems.orderId))
			.where(and(eq(orders.ownerId, ownerId), eq(orders.id, dropId)))
			.for("update", { of: orderItems });
		// Existing allocation status updates do not re-check their order FK.
		await tx
			.select({ id: allocations.id })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(
				and(eq(orders.ownerId, ownerId), inArray(orders.id, [keepId, dropId])),
			)
			.for("update", { of: allocations });

		const claimed = await tx
			.select({ id: allocations.id })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(
				and(
					eq(orders.ownerId, ownerId),
					eq(allocations.orderId, dropId),
					isNotNull(allocations.claimId),
				),
			);
		if (claimed.length)
			throw new Error(
				"The order being merged away is part of a reimbursement claim. Remove it from the claim (or merge the other way) first.",
			);
		const [settled] = await tx
			.select({ id: allocations.id })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(
				and(
					eq(orders.ownerId, ownerId),
					inArray(orders.id, [keepId, dropId]),
					inArray(allocations.reimbursementStatus, ["submitted", "reimbursed"]),
				),
			)
			.limit(1);
		if (settled)
			throw new Error(
				"An order has submitted or reimbursed payment history. Resolve its reimbursement before merging.",
			);
		const [statement] = await tx
			.select({ id: transactionMatches.id })
			.from(transactionMatches)
			.innerJoin(orders, eq(orders.id, transactionMatches.orderId))
			.where(
				and(
					eq(transactionMatches.ownerId, ownerId),
					eq(orders.ownerId, ownerId),
					eq(orders.id, dropId),
				),
			)
			.limit(1);
		if (statement)
			throw new Error(
				"The order being merged away has statement matches. Resolve those matches before merging.",
			);
		const [indirectAsset] = await tx
			.select({ id: assets.id })
			.from(assets)
			.innerJoin(orderItems, eq(orderItems.id, assets.orderItemId))
			.innerJoin(orders, eq(orders.id, orderItems.orderId))
			.where(
				and(
					eq(assets.ownerId, ownerId),
					eq(orders.ownerId, ownerId),
					eq(orders.id, dropId),
					sql`${assets.orderId} is distinct from ${dropId}::uuid`,
				),
			)
			.limit(1);
		if (indirectAsset)
			throw new Error(
				"An asset is linked through this order's line item without a matching order link. Resolve the asset link before merging.",
			);

		// Provenance.
		await tx.execute(sql`
			insert into ${orderCaptures} (order_id, capture_id, created_at)
			select ${keepId}, capture_id, created_at from ${orderCaptures}
			where order_id = ${dropId}
			on conflict do nothing`);

		// Documents: primary links and extra links.
		const movedDocs = await tx
			.update(documents)
			.set({ orderId: keepId })
			.where(and(eq(documents.orderId, dropId), eq(documents.ownerId, ownerId)))
			.returning({ id: documents.id });
		await tx.execute(sql`
			insert into ${documentLinks} (document_id, order_id, created_at)
			select document_id, ${keepId}, created_at from ${documentLinks}
			where order_id = ${dropId}
			on conflict do nothing`);
		await tx.execute(sql`
			delete from ${documentLinks} l using ${documents} d
			where l.document_id = d.id and l.order_id = ${keepId} and d.order_id = ${keepId}`);

		// Items.
		const [keepItems] = await tx
			.select({ n: sql<number>`count(*)`.mapWith(Number) })
			.from(orderItems)
			.where(eq(orderItems.orderId, keepId));
		let itemsMoved = 0;
		if ((keepItems?.n ?? 0) === 0) {
			const moved = await tx
				.update(orderItems)
				.set({ orderId: keepId })
				.where(eq(orderItems.orderId, dropId))
				.returning({ title: orderItems.title, sku: orderItems.sku });
			itemsMoved = moved.length;
			if (moved.length)
				await tx
					.update(orders)
					.set({ itemsText: itemsSearchText(moved) })
					.where(eq(orders.id, keepId));
		} else {
			// Dropped items are discarded, but assets/refunds pointing at them
			// would lose their line link; keep the link meaningful by title match.
			const keepRows = await tx
				.select({ id: orderItems.id, title: orderItems.title })
				.from(orderItems)
				.where(eq(orderItems.orderId, keepId));
			const dropRows = await tx
				.select({ id: orderItems.id, title: orderItems.title })
				.from(orderItems)
				.where(eq(orderItems.orderId, dropId));
			for (const d of dropRows) {
				const target = keepRows.find(
					(k) => k.title.trim().toLowerCase() === d.title.trim().toLowerCase(),
				);
				await tx
					.update(assets)
					.set({ orderItemId: target?.id ?? null })
					.where(eq(assets.orderItemId, d.id));
				await tx
					.update(refunds)
					.set({ orderItemId: target?.id ?? null })
					.where(eq(refunds.orderItemId, d.id));
			}
		}

		// Shipments (unique per order + tracking number).
		await tx.execute(sql`
			insert into ${shipments} (order_id, carrier, tracking_number, status, shipped_at, delivered_at, eta_text, updated_at)
			select ${keepId}, carrier, tracking_number, status, shipped_at, delivered_at, eta_text, updated_at
			from ${shipments} where order_id = ${dropId}
			on conflict (order_id, tracking_number) do nothing`);

		// Lifecycle rows.
		await tx
			.update(refunds)
			.set({ orderId: keepId })
			.where(eq(refunds.orderId, dropId));
		await tx
			.update(assets)
			.set({ orderId: keepId })
			.where(eq(assets.orderId, dropId));

		// Export history survives (allocation link nulls on delete).
		await tx
			.update(exports)
			.set({
				status: "stale",
				error: `Order merged into ${keep.source} ${keep.externalOrderId}; the remote expense may be a duplicate.`,
			})
			.where(and(eq(exports.orderId, dropId), eq(exports.status, "sent")));
		await tx
			.update(exports)
			.set({ orderId: keepId })
			.where(eq(exports.orderId, dropId));

		// Fill gaps on the kept order.
		const fill = <K extends keyof typeof keep>(key: K) =>
			keep[key] == null && drop[key] != null ? { [key]: drop[key] } : {};
		await tx
			.update(orders)
			.set({
				...fill("merchantName"),
				...fill("orderUrl"),
				...fill("orderDate"),
				...fill("currency"),
				...fill("subtotalMinor"),
				...fill("shippingMinor"),
				...fill("taxMinor"),
				...fill("discountMinor"),
				...fill("totalMinor"),
				...fill("paymentHint"),
				...fill("paymentMethodId"),
				...fill("entityId"),
				...fill("categoryId"),
				...fill("reimbursableOverride"),
				tags: [...new Set([...keep.tags, ...drop.tags])],
				notes: [keep.notes, drop.notes].filter(Boolean).join("\n\n") || null,
				updatedAt: new Date(),
			})
			.where(eq(orders.id, keepId));

		const metadata = {
			keptOrderId: keepId,
			mergedOrderId: dropId,
			mergedSource: drop.source,
			mergedExternalOrderId: drop.externalOrderId,
			mergedTotalMinor: drop.totalMinor,
			mergedCurrency: drop.currency,
			documentsMoved: movedDocs.length,
			itemsMoved,
		};
		const actor = { type: "user" as const, id: ownerId };
		await audit(tx, actor, "order.merged", keepId, metadata);
		await audit(tx, actor, "order.merged_away", dropId, metadata);

		await tx.delete(orders).where(eq(orders.id, dropId));
		await recomputeAllocations(tx, keepId);
		return { keepId, ...metadata };
	});
}
