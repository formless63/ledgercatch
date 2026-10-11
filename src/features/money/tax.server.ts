/**
 * Tax hints (advisory): suggestions per allocation, explicit acceptance into
 * `allocation_tax`, and a year-end summary by entity × treatment.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	allocations,
	categories,
	entities,
	orderItems,
	orders,
} from "#/features/ledger/schema";
import { convertMinorWithRate, exponentOf } from "./fx";
import { convertMinor, ensureFxRates, loadRateTable } from "./fx.server";
import { allocationTax, type TaxTreatment } from "./schema";
import { getReportingCurrency, getTaxProfiles } from "./settings.server";
import {
	DE_MINIMIS_USD_MINOR,
	EXPENSE_TREATMENTS,
	suggestTaxTreatments,
	TAX_DISCLAIMER,
	TAX_TREATMENT_LABELS,
	type TaxProfile,
	treatmentHint,
} from "./tax";

/** Factor turning `currency` minor units into USD cents at `date`. */
async function usdFactor(currency: string, date: string | null) {
	const code = currency.toUpperCase();
	if (code === "USD") return 1;
	const probe = 10 ** exponentOf(code);
	const result = await convertMinor(
		probe,
		code,
		"USD",
		date ?? new Date().toISOString().slice(0, 10),
	).catch(() => null);
	return result ? result.rate.rate * 10 ** (2 - exponentOf(code)) : null;
}

function profileFor(
	row: { jurisdiction: string | null; businessType: string | null } | undefined,
): TaxProfile {
	return {
		jurisdiction: (row?.jurisdiction as TaxProfile["jurisdiction"]) ?? null,
		businessType: (row?.businessType as TaxProfile["businessType"]) ?? null,
	};
}

export async function getTaxSuggestionsForOwner(
	ownerId: string,
	orderId: string,
) {
	const [order] = await db
		.select({
			id: orders.id,
			orderDate: orders.orderDate,
			entityId: orders.entityId,
			currency: orders.currency,
		})
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!order) throw new Error("NOT_FOUND");
	const [allocationRows, items, profiles] = await Promise.all([
		db
			.select({
				id: allocations.id,
				entityId: allocations.entityId,
				entityName: entities.name,
				entityKind: entities.kind,
				entityColor: entities.color,
				amountMinor: allocations.amountMinor,
				currency: allocations.currency,
				categoryId: allocations.categoryId,
				categoryName: categories.name,
				categoryCode: categories.code,
				accepted: allocationTax.treatment,
				acceptedOrigin: allocationTax.origin,
				acceptedNote: allocationTax.note,
				acceptedAmountMinor: allocationTax.amountMinor,
				acceptedAt: allocationTax.acceptedAt,
			})
			.from(allocations)
			.innerJoin(entities, eq(entities.id, allocations.entityId))
			.leftJoin(categories, eq(categories.id, allocations.categoryId))
			.leftJoin(allocationTax, eq(allocationTax.allocationId, allocations.id))
			.where(eq(allocations.orderId, orderId)),
		db
			.select({
				title: orderItems.title,
				quantity: orderItems.quantity,
				totalMinor: orderItems.totalMinor,
				entityId: orderItems.entityId,
			})
			.from(orderItems)
			.where(eq(orderItems.orderId, orderId)),
		getTaxProfiles(ownerId),
	]);
	const factor = await usdFactor(order.currency ?? "USD", order.orderDate);
	return {
		disclaimer: TAX_DISCLAIMER,
		allocations: allocationRows.map((row) => {
			const profile = profileFor(profiles.get(row.entityId));
			const own = items.filter(
				(item) => (item.entityId ?? order.entityId) === row.entityId,
			);
			const result = suggestTaxTreatments({
				entityKind: row.entityKind,
				profile,
				category: row.categoryName
					? { name: row.categoryName, code: row.categoryCode }
					: null,
				items: own.map((item) => ({
					title: item.title,
					quantity: Number(item.quantity) || 1,
					totalMinor: item.totalMinor,
				})),
				amountMinor: row.amountMinor,
				currency: row.currency,
				usdFactor: factor,
			});
			return {
				allocationId: row.id,
				entity: {
					id: row.entityId,
					name: row.entityName,
					kind: row.entityKind,
					color: row.entityColor,
				},
				profile,
				amountMinor: row.amountMinor,
				currency: row.currency,
				category: row.categoryName,
				accepted: row.accepted
					? {
							treatment: row.accepted,
							label: TAX_TREATMENT_LABELS[row.accepted],
							hint: treatmentHint(row.accepted, profile, row.entityKind),
							origin: row.acceptedOrigin,
							note: row.acceptedNote,
							acceptedAt: row.acceptedAt?.toISOString() ?? null,
							amountChanged: row.acceptedAmountMinor !== row.amountMinor,
						}
					: null,
				suggestions: result.suggestions,
				largeItems: result.largeItems,
			};
		}),
	};
}

async function ownedAllocation(ownerId: string, allocationId: string) {
	const [row] = await db
		.select({
			id: allocations.id,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(and(eq(allocations.id, allocationId), eq(orders.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

/** Explicit user acceptance — the only way a treatment is stored. */
export async function acceptTaxTreatmentForOwner(
	ownerId: string,
	input: {
		allocationId: string;
		treatment: TaxTreatment;
		origin: "suggestion" | "manual";
		note?: string | null;
	},
) {
	const allocation = await ownedAllocation(ownerId, input.allocationId);
	const values = {
		treatment: input.treatment,
		origin: input.origin,
		note: input.note ?? null,
		amountMinor: allocation.amountMinor,
		currency: allocation.currency,
		acceptedAt: new Date(),
	};
	await db
		.insert(allocationTax)
		.values({ allocationId: allocation.id, ownerId, ...values })
		.onConflictDoUpdate({ target: allocationTax.allocationId, set: values });
	return { ok: true };
}

export async function clearTaxTreatmentForOwner(
	ownerId: string,
	allocationId: string,
) {
	await db
		.delete(allocationTax)
		.where(
			and(
				eq(allocationTax.allocationId, allocationId),
				eq(allocationTax.ownerId, ownerId),
			),
		);
	return { ok: true };
}

/**
 * Year-end view: per entity, accepted treatments (plus "unreviewed") with
 * totals in the entity's reporting currency, and flags for allocations
 * ≥ $2,500 that were accepted as plain expenses (capitalization review).
 */
export async function getTaxSummaryForOwner(
	ownerId: string,
	input: { year: number; entityId?: string },
) {
	const from = `${input.year}-01-01`;
	const to = `${input.year}-12-31`;
	const rows = await db
		.select({
			allocationId: allocations.id,
			orderId: orders.id,
			orderDate: orders.orderDate,
			merchantName: orders.merchantName,
			source: orders.source,
			externalOrderId: orders.externalOrderId,
			entityId: allocations.entityId,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
			treatment: allocationTax.treatment,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.leftJoin(allocationTax, eq(allocationTax.allocationId, allocations.id))
		.where(
			and(
				eq(orders.ownerId, ownerId),
				gte(orders.orderDate, from),
				lte(orders.orderDate, to),
				sql`${orders.reviewState} <> 'ignored'`,
				sql`${orders.status} <> 'cancelled'`,
				...(input.entityId ? [eq(allocations.entityId, input.entityId)] : []),
			),
		);
	const entityIds = [...new Set(rows.map((row) => row.entityId))];
	const [entityRows, profiles] = await Promise.all([
		entityIds.length
			? db
					.select({
						id: entities.id,
						name: entities.name,
						kind: entities.kind,
						color: entities.color,
					})
					.from(entities)
					.where(inArray(entities.id, entityIds))
			: Promise.resolve([]),
		getTaxProfiles(ownerId),
	]);
	const currencies = new Set(rows.map((row) => row.currency.toUpperCase()));
	const targets = new Map<string, string>();
	for (const entity of entityRows)
		targets.set(entity.id, await getReportingCurrency(ownerId, entity.id));
	const all = new Set([...currencies, ...targets.values(), "USD"]);
	if (all.size > 1) await ensureFxRates(from, to).catch(() => undefined);
	const table = await loadRateTable(from, to, [...all]);
	const convert = (
		amount: number,
		fromCur: string,
		toCur: string,
		date: string | null,
	) => {
		if (fromCur.toUpperCase() === toCur.toUpperCase()) return amount;
		const rate = table.rate(fromCur, toCur, date ?? to);
		return rate
			? convertMinorWithRate(amount, fromCur, toCur, rate.rate)
			: null;
	};

	const flags: Array<{
		allocationId: string;
		orderId: string;
		orderDate: string | null;
		merchant: string;
		entityId: string;
		treatment: string;
		amountMinor: number;
		currency: string;
		usdMinor: number;
	}> = [];
	const summary = entityRows.map((entity) => {
		const currency = targets.get(entity.id) ?? "USD";
		const profile = profileFor(profiles.get(entity.id));
		const buckets = new Map<string, { count: number; amountMinor: number }>();
		let totalMinor = 0;
		let unconverted = 0;
		for (const row of rows) {
			if (row.entityId !== entity.id) continue;
			const key = row.treatment ?? "unreviewed";
			const amount = convert(
				row.amountMinor,
				row.currency,
				currency,
				row.orderDate,
			);
			if (amount == null) {
				unconverted += 1;
				continue;
			}
			const bucket = buckets.get(key) ?? { count: 0, amountMinor: 0 };
			bucket.count += 1;
			bucket.amountMinor += amount;
			buckets.set(key, bucket);
			totalMinor += amount;
			const usd = convert(row.amountMinor, row.currency, "USD", row.orderDate);
			if (
				usd != null &&
				usd >= DE_MINIMIS_USD_MINOR &&
				row.treatment &&
				EXPENSE_TREATMENTS.includes(row.treatment) &&
				row.treatment !== "de_minimis"
			)
				flags.push({
					allocationId: row.allocationId,
					orderId: row.orderId,
					orderDate: row.orderDate,
					merchant: row.merchantName ?? `${row.source} ${row.externalOrderId}`,
					entityId: entity.id,
					treatment: TAX_TREATMENT_LABELS[row.treatment],
					amountMinor: row.amountMinor,
					currency: row.currency,
					usdMinor: usd,
				});
		}
		return {
			entity,
			currency,
			profile,
			totalMinor,
			unconverted,
			rows: [...buckets.entries()]
				.map(([treatment, value]) => ({
					treatment,
					label:
						treatment === "unreviewed"
							? "Not reviewed"
							: TAX_TREATMENT_LABELS[treatment as TaxTreatment],
					hint:
						treatment === "unreviewed"
							? null
							: treatmentHint(treatment as TaxTreatment, profile, entity.kind),
					...value,
				}))
				.sort((a, b) => b.amountMinor - a.amountMinor),
		};
	});
	return {
		year: input.year,
		disclaimer: TAX_DISCLAIMER,
		entities: summary,
		flags: flags.slice(0, 100),
	};
}
