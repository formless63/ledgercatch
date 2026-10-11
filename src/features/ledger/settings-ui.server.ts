/**
 * Server helpers for the Settings / Rules / Extension pages that the core
 * ledger module does not cover (usage counts, batch onboarding, ordering). Every function resolves the session user first and
 * filters by owner.
 */
import { and, count, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { requireUser } from "./ledger.server";
import {
	categories,
	connections,
	entities,
	orderItems,
	orders,
	rules,
} from "./schema";
import type { onboardInput, ruleEnabledInput } from "./settings-ui.functions";

type OnboardInput = z.output<typeof onboardInput>;
type RuleEnabledInput = z.output<typeof ruleEnabledInput>;

/* ───────────────────────── usage ───────────────────────── */

/** Order counts per entity / category / payment method for settings tables. */
export async function getSettingsUsage() {
	return getSettingsUsageForOwner((await requireUser()).id);
}

export async function getSettingsUsageForOwner(ownerId: string) {
	const user = { id: ownerId };
	const [byEntity, byCategory, byItemCategory, byMethod, connectionRows] =
		await Promise.all([
			db
				.select({ id: orders.entityId, n: count() })
				.from(orders)
				.where(and(eq(orders.ownerId, user.id), isNotNull(orders.entityId)))
				.groupBy(orders.entityId),
			db
				.select({ id: orders.categoryId, n: count() })
				.from(orders)
				.where(and(eq(orders.ownerId, user.id), isNotNull(orders.categoryId)))
				.groupBy(orders.categoryId),
			db
				.select({ id: orderItems.categoryId, n: count() })
				.from(orderItems)
				.innerJoin(orders, eq(orders.id, orderItems.orderId))
				.where(
					and(eq(orders.ownerId, user.id), isNotNull(orderItems.categoryId)),
				)
				.groupBy(orderItems.categoryId),
			db
				.select({
					id: orders.paymentMethodId,
					n: count(),
					lastUsed: max(orders.orderDate),
					totalMinor:
						sql<number>`coalesce(sum(${orders.totalMinor}), 0)::bigint`.mapWith(
							Number,
						),
				})
				.from(orders)
				.where(
					and(eq(orders.ownerId, user.id), isNotNull(orders.paymentMethodId)),
				)
				.groupBy(orders.paymentMethodId),
			db
				.select({ entityId: connections.entityId, n: count() })
				.from(connections)
				.where(eq(connections.ownerId, user.id))
				.groupBy(connections.entityId),
		]);
	const toMap = (rows: Array<{ id: string | null; n: number }>) => {
		const out: Record<string, number> = {};
		for (const row of rows)
			if (row.id) out[row.id] = (out[row.id] ?? 0) + row.n;
		return out;
	};
	const categoryOrders = toMap(byCategory);
	for (const row of byItemCategory)
		if (row.id) categoryOrders[row.id] = (categoryOrders[row.id] ?? 0) + row.n;
	const paymentMethodUsage: Record<
		string,
		{ orders: number; lastUsed: string | null; totalMinor: number }
	> = {};
	for (const row of byMethod)
		if (row.id)
			paymentMethodUsage[row.id] = {
				orders: row.n,
				lastUsed: row.lastUsed ?? null,
				totalMinor: row.totalMinor,
			};
	const entityConnections: Record<string, number> = {};
	for (const row of connectionRows) entityConnections[row.entityId] = row.n;
	return {
		entityOrders: toMap(byEntity),
		categoryUses: categoryOrders,
		paymentMethodUsage,
		entityConnections,
	};
}

/* ───────────────────────── onboarding / ordering ───────────────────────── */

/** First-run: create several entities (and optional shared categories) at once. */
export async function onboardEntities(input: OnboardInput) {
	return onboardEntitiesForOwner((await requireUser()).id, input);
}

export async function onboardEntitiesForOwner(
	ownerId: string,
	input: OnboardInput,
) {
	const user = { id: ownerId };
	const defaultIndex = Math.max(
		0,
		input.entities.findIndex((e) => e.isDefault),
	);
	return db.transaction(async (tx) => {
		if (input.entities.some((e) => e.isDefault))
			await tx
				.update(entities)
				.set({ isDefault: false })
				.where(eq(entities.ownerId, user.id));
		const [existing] = await tx
			.select({ n: count() })
			.from(entities)
			.where(eq(entities.ownerId, user.id));
		const offset = (existing?.n ?? 0) * 10;
		const created = await tx
			.insert(entities)
			.values(
				input.entities.map((entity, index) => ({
					ownerId: user.id,
					name: entity.name,
					shortName: entity.shortName || null,
					kind: entity.kind,
					color: entity.color,
					isDefault: (existing?.n ?? 0) === 0 && index === defaultIndex,
					sort: offset + (index + 1) * 10,
				})),
			)
			.returning({ id: entities.id });
		if (input.categories.length)
			await tx.insert(categories).values(
				[...new Set(input.categories)].map((name) => ({
					ownerId: user.id,
					name,
				})),
			);
		return { entityIds: created.map((row) => row.id) };
	});
}

/** Persist entity order (sort = position * 10). */
export async function reorderEntities(ids: string[]) {
	return reorderEntitiesForOwner((await requireUser()).id, ids);
}

export async function reorderEntitiesForOwner(ownerId: string, ids: string[]) {
	const user = { id: ownerId };
	await db.transaction(async (tx) => {
		for (const [index, id] of ids.entries())
			await tx
				.update(entities)
				.set({ sort: (index + 1) * 10 })
				.where(and(eq(entities.id, id), eq(entities.ownerId, user.id)));
	});
	return { ok: true };
}

/** Persist rule priority order (priority = position * 10). */
export async function reorderRules(ids: string[]) {
	return reorderRulesForOwner((await requireUser()).id, ids);
}

export async function reorderRulesForOwner(ownerId: string, ids: string[]) {
	const user = { id: ownerId };
	const owned = await db
		.select({ id: rules.id })
		.from(rules)
		.where(and(eq(rules.ownerId, user.id), inArray(rules.id, ids)));
	const ownedIds = new Set(owned.map((row) => row.id));
	await db.transaction(async (tx) => {
		for (const [index, id] of ids.entries()) {
			if (!ownedIds.has(id)) continue;
			await tx
				.update(rules)
				.set({ priority: (index + 1) * 10, updatedAt: new Date() })
				.where(eq(rules.id, id));
		}
	});
	return { ok: true };
}

export async function setRuleEnabled(input: RuleEnabledInput) {
	return setRuleEnabledForOwner((await requireUser()).id, input);
}

export async function setRuleEnabledForOwner(
	ownerId: string,
	input: RuleEnabledInput,
) {
	const user = { id: ownerId };
	const [row] = await db
		.update(rules)
		.set({ enabled: input.enabled, updatedAt: new Date() })
		.where(and(eq(rules.id, input.id), eq(rules.ownerId, user.id)))
		.returning({ id: rules.id });
	if (!row) throw new Error("NOT_FOUND");
	return row;
}
