import { and, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import type { insightsInput } from "./inputs";
import { requireUser } from "./ledger.server";
import { allocations, categories, documents, orders } from "./schema";

/** Spend analytics over allocations (assigned spend) and orders (all captured). */
export async function getInsights(input: z.output<typeof insightsInput>) {
	return getInsightsForOwner((await requireUser()).id, input);
}

export async function getInsightsForOwner(
	ownerId: string,
	input: z.output<typeof insightsInput>,
) {
	const user = { id: ownerId };
	const to = input.to ?? new Date().toISOString().slice(0, 10);
	const from =
		input.from ??
		new Date(new Date(to).getTime() - 365 * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const orderWhere: SQL[] = [
		eq(orders.ownerId, user.id),
		gte(orders.orderDate, from),
		lte(orders.orderDate, to),
		sql`${orders.reviewState} <> 'ignored'`,
		sql`${orders.status} <> 'cancelled'`,
	];
	const allocationWhere = [...orderWhere];
	if (input.entityId)
		allocationWhere.push(eq(allocations.entityId, input.entityId));

	const month = sql<string>`to_char(${orders.orderDate}::date, 'YYYY-MM')`;
	const sumAlloc =
		sql<number>`coalesce(sum(${allocations.amountMinor}), 0)::bigint`.mapWith(
			Number,
		);

	const [
		byMonthEntity,
		byEntity,
		bySource,
		byCategory,
		reimbursement,
		totals,
		missing,
	] = await Promise.all([
		db
			.select({
				month,
				entityId: allocations.entityId,
				currency: allocations.currency,
				amountMinor: sumAlloc,
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(...allocationWhere))
			.groupBy(month, allocations.entityId, allocations.currency)
			.orderBy(month),
		db
			.select({
				entityId: allocations.entityId,
				currency: allocations.currency,
				amountMinor: sumAlloc,
				orders: sql<number>`count(distinct ${orders.id})`.mapWith(Number),
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(...allocationWhere))
			.groupBy(allocations.entityId, allocations.currency),
		db
			.select({
				source: orders.source,
				currency: orders.currency,
				amountMinor:
					sql<number>`coalesce(sum(${orders.totalMinor}), 0)::bigint`.mapWith(
						Number,
					),
				orders: sql<number>`count(*)`.mapWith(Number),
			})
			.from(orders)
			.where(and(...orderWhere))
			.groupBy(orders.source, orders.currency),
		db
			.select({
				categoryId: allocations.categoryId,
				name: categories.name,
				currency: allocations.currency,
				amountMinor: sumAlloc,
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.leftJoin(categories, eq(categories.id, allocations.categoryId))
			.where(and(...allocationWhere))
			.groupBy(allocations.categoryId, categories.name, allocations.currency),
		db
			.select({
				status: allocations.reimbursementStatus,
				currency: allocations.currency,
				amountMinor: sumAlloc,
				count: sql<number>`count(*)`.mapWith(Number),
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(...allocationWhere, eq(allocations.reimbursable, true)))
			.groupBy(allocations.reimbursementStatus, allocations.currency),
		db
			.select({
				currency: orders.currency,
				amountMinor:
					sql<number>`coalesce(sum(${orders.totalMinor}), 0)::bigint`.mapWith(
						Number,
					),
				taxMinor:
					sql<number>`coalesce(sum(${orders.taxMinor}), 0)::bigint`.mapWith(
						Number,
					),
				orders: sql<number>`count(*)`.mapWith(Number),
				unassigned:
					sql<number>`count(*) filter (where ${orders.entityId} is null)`.mapWith(
						Number,
					),
			})
			.from(orders)
			.where(and(...orderWhere))
			.groupBy(orders.currency),
		db
			.select({
				id: orders.id,
				source: orders.source,
				externalOrderId: orders.externalOrderId,
				merchantName: orders.merchantName,
				orderDate: orders.orderDate,
				totalMinor: orders.totalMinor,
				currency: orders.currency,
				entityId: orders.entityId,
			})
			.from(orders)
			.where(
				and(
					...orderWhere,
					sql`${orders.entityId} is not null`,
					sql`not exists (select 1 from ${documents} d where (d.order_id = "orders"."id" or exists (select 1 from document_links l where l.document_id = d.id and l.order_id = "orders"."id")) and d.kind in ('invoice','receipt'))`,
				),
			)
			.orderBy(sql`${orders.orderDate} desc`)
			.limit(50),
	]);

	return {
		range: { from, to },
		byMonthEntity,
		byEntity,
		bySource,
		byCategory,
		reimbursement,
		totals,
		missingInvoices: missing,
	};
}
