/** Per-entity budgets: owner-scoped CRUD, progress and threshold alerts. */
import { and, asc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import { formatMoney } from "#/components/app/format";
import { db } from "#/db";
import {
	allocations,
	categories,
	entities,
	orders,
} from "#/features/ledger/schema";
import { alertToSend, budgetLevel, periodWindow, progressPct } from "./budgets";
import { budgetInput } from "./inputs";
import { notifyOwner } from "./notify.server";
import { budgets } from "./schema";

export { budgetInput };

type Budget = typeof budgets.$inferSelect;

async function assertOwned(
	ownerId: string,
	entityId: string,
	categoryId?: string | null,
) {
	const [entity] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.id, entityId), eq(entities.ownerId, ownerId)));
	if (!entity) throw new Error("Unknown entity");
	if (categoryId) {
		const [category] = await db
			.select({ id: categories.id })
			.from(categories)
			.where(
				and(eq(categories.id, categoryId), eq(categories.ownerId, ownerId)),
			);
		if (!category) throw new Error("Unknown category");
	}
}

export async function saveBudgetForOwner(
	ownerId: string,
	input: z.output<typeof budgetInput>,
) {
	await assertOwned(ownerId, input.entityId, input.categoryId);
	const values = {
		entityId: input.entityId,
		categoryId: input.categoryId ?? null,
		period: input.period,
		amountMinor: input.amountMinor,
		currency: input.currency,
		thresholdPct: input.thresholdPct,
		enabled: input.enabled,
		updatedAt: new Date(),
	};
	if (input.id) {
		const [row] = await db
			.update(budgets)
			// A changed limit re-arms alerts for the current period.
			.set({ ...values, alertedPeriod: null, alertedLevel: null })
			.where(and(eq(budgets.id, input.id), eq(budgets.ownerId, ownerId)))
			.returning({ id: budgets.id });
		if (!row) throw new Error("NOT_FOUND");
		return row;
	}
	const [row] = await db
		.insert(budgets)
		.values({ ...values, ownerId })
		.returning({ id: budgets.id });
	if (!row) throw new Error("Budget insert failed");
	return row;
}

export async function deleteBudgetForOwner(ownerId: string, id: string) {
	await db
		.delete(budgets)
		.where(and(eq(budgets.id, id), eq(budgets.ownerId, ownerId)));
	return { ok: true };
}

/** Spend for one budget in its current period (allocations by order date). */
async function spentFor(budget: Budget, now: Date) {
	const window = periodWindow(budget.period, now);
	const day = sql<string>`coalesce(${orders.orderDate}, (${orders.firstSeenAt} at time zone 'UTC')::date)`;
	const [row] = await db
		.select({
			total:
				sql<number>`coalesce(sum(${allocations.amountMinor}), 0)::bigint`.mapWith(
					Number,
				),
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(
			and(
				eq(orders.ownerId, budget.ownerId),
				eq(allocations.entityId, budget.entityId),
				eq(allocations.currency, budget.currency),
				budget.categoryId
					? eq(allocations.categoryId, budget.categoryId)
					: undefined,
				ne(orders.reviewState, "ignored"),
				ne(orders.status, "cancelled"),
				gte(day, window.start),
				lt(day, window.end),
			),
		);
	return { spentMinor: row?.total ?? 0, window };
}

export async function listBudgetsForOwner(ownerId: string, now = new Date()) {
	const rows = await db
		.select({
			budget: budgets,
			entityName: entities.name,
			entityColor: entities.color,
			categoryName: categories.name,
		})
		.from(budgets)
		.innerJoin(entities, eq(entities.id, budgets.entityId))
		.leftJoin(categories, eq(categories.id, budgets.categoryId))
		.where(eq(budgets.ownerId, ownerId))
		.orderBy(asc(entities.sort), asc(entities.name), asc(budgets.period));
	return Promise.all(
		rows.map(async (row) => {
			const { spentMinor, window } = await spentFor(row.budget, now);
			const { budget } = row;
			return {
				id: budget.id,
				entityId: budget.entityId,
				entityName: row.entityName,
				entityColor: row.entityColor,
				categoryId: budget.categoryId,
				categoryName: row.categoryName,
				period: budget.period,
				periodKey: window.key,
				periodStart: window.start,
				periodEnd: window.end,
				amountMinor: budget.amountMinor,
				currency: budget.currency,
				thresholdPct: budget.thresholdPct,
				enabled: budget.enabled,
				spentMinor,
				pct: progressPct(spentMinor, budget.amountMinor),
				level: budgetLevel(spentMinor, budget.amountMinor, budget.thresholdPct),
			};
		}),
	);
}

/** Job: compare current spend to every enabled budget and alert on crossings. */
export async function evaluateBudgetsForOwner(
	ownerId: string,
	now = new Date(),
) {
	const rows = await db
		.select({
			budget: budgets,
			entityName: entities.name,
			categoryName: categories.name,
		})
		.from(budgets)
		.innerJoin(entities, eq(entities.id, budgets.entityId))
		.leftJoin(categories, eq(categories.id, budgets.categoryId))
		.where(and(eq(budgets.ownerId, ownerId), eq(budgets.enabled, true)));
	let alerts = 0;
	for (const { budget, entityName, categoryName } of rows) {
		const { spentMinor, window } = await spentFor(budget, now);
		const level = budgetLevel(
			spentMinor,
			budget.amountMinor,
			budget.thresholdPct,
		);
		const send = alertToSend({
			level,
			periodKey: window.key,
			alertedPeriod: budget.alertedPeriod,
			alertedLevel: budget.alertedLevel,
		});
		if (!send) continue;
		// Record first (conditional on the state we read) so concurrent runs alert once.
		const [claimed] = await db
			.update(budgets)
			.set({ alertedPeriod: window.key, alertedLevel: send })
			.where(
				and(
					eq(budgets.id, budget.id),
					budget.alertedPeriod === null
						? isNull(budgets.alertedPeriod)
						: eq(budgets.alertedPeriod, budget.alertedPeriod),
					budget.alertedLevel === null
						? isNull(budgets.alertedLevel)
						: eq(budgets.alertedLevel, budget.alertedLevel),
				),
			)
			.returning({ id: budgets.id });
		if (!claimed) continue;
		const scope = categoryName ? `${entityName} · ${categoryName}` : entityName;
		const pct = progressPct(spentMinor, budget.amountMinor);
		await notifyOwner(ownerId, {
			alert: "budgets",
			type: send === "exceeded" ? "budget.exceeded" : "budget.threshold",
			title:
				send === "exceeded"
					? `Budget exceeded: ${scope}`
					: `Budget at ${pct}%: ${scope}`,
			body: `${scope} has spent ${formatMoney(spentMinor, budget.currency)} of ${formatMoney(budget.amountMinor, budget.currency)} this ${budget.period} (${window.key}, ${pct}%).`,
			link: "/app/budgets",
			metadata: { budgetId: budget.id, period: window.key, level: send },
		});
		alerts += 1;
	}
	return { budgets: rows.length, alerts };
}

/** Owners with at least one enabled budget (for the periodic sweep). */
export async function ownersWithBudgets() {
	const rows = await db
		.selectDistinct({ ownerId: budgets.ownerId })
		.from(budgets)
		.where(eq(budgets.enabled, true));
	return rows.map((row) => row.ownerId);
}
