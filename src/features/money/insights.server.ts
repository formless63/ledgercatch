/**
 * Insights and reimbursement summaries in one reporting currency. Each
 * amount is converted at the ECB reference rate of its order date.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	allocations,
	categories,
	orders,
	paymentMethods,
} from "#/features/ledger/schema";
import { convertMinorWithRate, type RateTable } from "./fx";
import { ensureFxRates, loadRateTable } from "./fx.server";
import { getReportingCurrency } from "./settings.server";

export type ConvertedInsightsInput = {
	from?: string;
	to?: string;
	entityId?: string;
	/** Override; default = entity setting → user setting → USD. */
	currency?: string;
};

type Unconverted = Map<string, { amountMinor: number; count: number }>;

function converter(table: RateTable, target: string, fallbackDate: string) {
	const unconverted: Unconverted = new Map();
	const convert = (
		amountMinor: number,
		currency: string | null,
		date: string | null,
	): number | null => {
		const from = (currency ?? "USD").toUpperCase();
		if (from === target) return amountMinor;
		const rate = table.rate(from, target, date ?? fallbackDate);
		if (!rate) {
			const entry = unconverted.get(from) ?? { amountMinor: 0, count: 0 };
			entry.amountMinor += amountMinor;
			entry.count += 1;
			unconverted.set(from, entry);
			return null;
		}
		return convertMinorWithRate(amountMinor, from, target, rate.rate);
	};
	return {
		convert,
		unconverted: () =>
			[...unconverted.entries()].map(([currency, value]) => ({
				currency,
				...value,
			})),
	};
}

async function prepareTable(
	from: string,
	to: string,
	currencies: Array<string | null>,
	target: string,
) {
	const set = new Set(
		currencies.map((c) => (c ?? "USD").toUpperCase()).concat(target),
	);
	if (set.size > 1) {
		try {
			await ensureFxRates(from, to);
		} catch {
			// Missing rates are reported as unconverted.
		}
	}
	return loadRateTable(from, to, [...set]);
}

function add<K>(map: Map<K, number>, key: K, value: number) {
	map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * Same questions as getInsightsForOwner, answered in one currency:
 * spend by month × entity, entity, store, category; reimbursement totals.
 */
export async function getInsightsConvertedForOwner(
	ownerId: string,
	input: ConvertedInsightsInput,
) {
	const to = input.to ?? new Date().toISOString().slice(0, 10);
	const from =
		input.from ??
		new Date(new Date(to).getTime() - 365 * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const currency = (
		input.currency ?? (await getReportingCurrency(ownerId, input.entityId))
	).toUpperCase();
	const orderWhere = [
		eq(orders.ownerId, ownerId),
		gte(orders.orderDate, from),
		lte(orders.orderDate, to),
		sql`${orders.reviewState} <> 'ignored'`,
		sql`${orders.status} <> 'cancelled'`,
	];
	const [allocationRows, orderRows] = await Promise.all([
		db
			.select({
				orderId: orders.id,
				orderDate: orders.orderDate,
				entityId: allocations.entityId,
				categoryId: allocations.categoryId,
				categoryName: categories.name,
				amountMinor: allocations.amountMinor,
				currency: allocations.currency,
				reimbursable: allocations.reimbursable,
				status: allocations.reimbursementStatus,
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.leftJoin(categories, eq(categories.id, allocations.categoryId))
			.where(
				and(
					...orderWhere,
					...(input.entityId ? [eq(allocations.entityId, input.entityId)] : []),
				),
			),
		db
			.select({
				orderDate: orders.orderDate,
				source: orders.source,
				currency: orders.currency,
				totalMinor: orders.totalMinor,
				taxMinor: orders.taxMinor,
				entityId: orders.entityId,
			})
			.from(orders)
			.where(and(...orderWhere)),
	]);
	const table = await prepareTable(
		from,
		to,
		[
			...allocationRows.map((r) => r.currency),
			...orderRows.map((r) => r.currency),
		],
		currency,
	);
	const { convert, unconverted } = converter(table, currency, to);

	const byMonthEntity = new Map<string, number>();
	const byEntity = new Map<string, number>();
	const entityOrders = new Map<string, Set<string>>();
	const byCategory = new Map<string, { name: string | null; amount: number }>();
	const reimbursement = new Map<string, { amount: number; count: number }>();
	for (const row of allocationRows) {
		const amount = convert(row.amountMinor, row.currency, row.orderDate);
		if (amount == null) continue;
		const month = (row.orderDate ?? to).slice(0, 7);
		add(byMonthEntity, `${month}|${row.entityId}`, amount);
		add(byEntity, row.entityId, amount);
		const set = entityOrders.get(row.entityId) ?? new Set<string>();
		set.add(row.orderId);
		entityOrders.set(row.entityId, set);
		const categoryKey = row.categoryId ?? "";
		const category = byCategory.get(categoryKey) ?? {
			name: row.categoryName,
			amount: 0,
		};
		category.amount += amount;
		byCategory.set(categoryKey, category);
		if (row.reimbursable) {
			const entry = reimbursement.get(row.status) ?? { amount: 0, count: 0 };
			entry.amount += amount;
			entry.count += 1;
			reimbursement.set(row.status, entry);
		}
	}
	const bySource = new Map<string, { amount: number; orders: number }>();
	let total = 0;
	let tax = 0;
	let unassigned = 0;
	for (const row of orderRows) {
		if (input.entityId) break;
		const amount = convert(row.totalMinor ?? 0, row.currency, row.orderDate);
		if (amount == null) continue;
		total += amount;
		tax += convert(row.taxMinor ?? 0, row.currency, row.orderDate) ?? 0;
		if (!row.entityId) unassigned += 1;
		const entry = bySource.get(row.source) ?? { amount: 0, orders: 0 };
		entry.amount += amount;
		entry.orders += 1;
		bySource.set(row.source, entry);
	}
	if (input.entityId) total = [...byEntity.values()].reduce((a, b) => a + b, 0);

	return {
		range: { from, to },
		currency,
		byMonthEntity: [...byMonthEntity.entries()]
			.map(([key, amountMinor]) => {
				const [month = "", entityId = ""] = key.split("|");
				return { month, entityId, amountMinor };
			})
			.sort((a, b) => (a.month < b.month ? -1 : 1)),
		byEntity: [...byEntity.entries()].map(([entityId, amountMinor]) => ({
			entityId,
			amountMinor,
			orders: entityOrders.get(entityId)?.size ?? 0,
		})),
		bySource: [...bySource.entries()].map(([source, value]) => ({
			source,
			amountMinor: value.amount,
			orders: value.orders,
		})),
		byCategory: [...byCategory.entries()].map(([categoryId, value]) => ({
			categoryId: categoryId || null,
			name: value.name,
			amountMinor: value.amount,
		})),
		reimbursement: [...reimbursement.entries()].map(([status, value]) => ({
			status,
			amountMinor: value.amount,
			count: value.count,
		})),
		totals: {
			amountMinor: total,
			taxMinor: tax,
			orders: input.entityId
				? new Set(allocationRows.map((r) => r.orderId)).size
				: orderRows.length,
			unassigned,
		},
		/** Amounts without a rate (left out of the totals above). */
		unconverted: unconverted(),
	};
}

/**
 * Open reimbursements (pending / submitted / rejected) grouped by who paid
 * and who owes, converted to the reporting currency.
 */
export async function getReimbursementsConvertedForOwner(
	ownerId: string,
	input: { currency?: string } = {},
) {
	const currency = (
		input.currency ?? (await getReportingCurrency(ownerId))
	).toUpperCase();
	const rows = await db
		.select({
			orderDate: orders.orderDate,
			owingEntityId: allocations.entityId,
			payerEntityId: paymentMethods.payingEntityId,
			status: allocations.reimbursementStatus,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.leftJoin(paymentMethods, eq(paymentMethods.id, orders.paymentMethodId))
		.where(
			and(
				eq(orders.ownerId, ownerId),
				eq(allocations.reimbursable, true),
				inArray(allocations.reimbursementStatus, [
					"pending",
					"submitted",
					"rejected",
				]),
			),
		);
	const dates = rows.map((r) => r.orderDate).filter(Boolean) as string[];
	const today = new Date().toISOString().slice(0, 10);
	const table = await prepareTable(
		dates.sort()[0] ?? today,
		today,
		rows.map((r) => r.currency),
		currency,
	);
	const { convert, unconverted } = converter(table, currency, today);
	const groups = new Map<
		string,
		{
			payerEntityId: string | null;
			owingEntityId: string;
			status: string;
			amountMinor: number;
			count: number;
		}
	>();
	for (const row of rows) {
		const amount = convert(row.amountMinor, row.currency, row.orderDate);
		if (amount == null) continue;
		const key = `${row.payerEntityId}|${row.owingEntityId}|${row.status}`;
		const group = groups.get(key) ?? {
			payerEntityId: row.payerEntityId,
			owingEntityId: row.owingEntityId,
			status: row.status,
			amountMinor: 0,
			count: 0,
		};
		group.amountMinor += amount;
		group.count += 1;
		groups.set(key, group);
	}
	return {
		currency,
		groups: [...groups.values()],
		unconverted: unconverted(),
	};
}
