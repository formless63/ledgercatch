import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { saveRuleForOwner } from "./ledger.server";
import { applyRulesToInbox } from "./process.server";
import {
	entities,
	orders,
	paymentMethods,
	type RuleCondition,
	rules,
} from "./schema";

export const SUGGESTION_FIELDS = [
	"payment_last4",
	"placed_by_group",
	"ship_to_address",
	"checkout_email_domain",
] as const;
export type SuggestionField = (typeof SUGGESTION_FIELDS)[number];

/** Only owner-scoped, unassigned inbox facts contribute to candidates. */
export async function listRuleSuggestionsForOwner(ownerId: string) {
	const rows = await db
		.select({
			last4: paymentMethods.last4,
			payingEntityId: paymentMethods.payingEntityId,
			placedByGroup: orders.placedByGroup,
			shipToAddress: orders.shipToAddress,
			checkoutEmailDomain: orders.checkoutEmailDomain,
		})
		.from(orders)
		.leftJoin(
			paymentMethods,
			and(
				eq(paymentMethods.id, orders.paymentMethodId),
				eq(paymentMethods.ownerId, ownerId),
			),
		)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				eq(orders.reviewState, "inbox"),
				isNull(orders.entityId),
			),
		);
	const activeEntities = await db
		.select({ id: entities.id, name: entities.name })
		.from(entities)
		.where(and(eq(entities.ownerId, ownerId), isNull(entities.archivedAt)));
	const existing = await db
		.select({ conditions: rules.conditions, actions: rules.actions })
		.from(rules)
		.where(and(eq(rules.ownerId, ownerId), eq(rules.enabled, true)));
	const candidates = new Map<
		string,
		{
			key: string;
			field: SuggestionField;
			value: string;
			matchCount: number;
			suggestedEntityId: string | null;
		}
	>();
	for (const row of rows) {
		const signals: Array<[SuggestionField, string | null]> = [
			["payment_last4", row.last4],
			["placed_by_group", row.placedByGroup],
			["ship_to_address", row.shipToAddress],
			["checkout_email_domain", row.checkoutEmailDomain],
		];
		for (const [field, raw] of signals) {
			const value = raw?.trim();
			if (!value) continue;
			const key = JSON.stringify([field, value.toLowerCase()]);
			if (
				existing.some(
					(rule) =>
						rule.actions.entityId &&
						rule.conditions.length === 1 &&
						rule.conditions[0]?.field === field &&
						rule.conditions[0]?.op === "equals" &&
						rule.conditions[0]?.value.toLowerCase() === value.toLowerCase(),
				)
			)
				continue;
			const candidate = candidates.get(key);
			if (candidate) {
				candidate.matchCount++;
				continue;
			}
			const named =
				field === "placed_by_group"
					? activeEntities.find(
							(e) => e.name.toLowerCase() === value.toLowerCase(),
						)?.id
					: null;
			const paying =
				field === "payment_last4" &&
				activeEntities.some((e) => e.id === row.payingEntityId)
					? row.payingEntityId
					: null;
			candidates.set(key, {
				key,
				field,
				value,
				matchCount: 1,
				suggestedEntityId: named ?? paying ?? null,
			});
		}
	}
	return [...candidates.values()].sort(
		(a, b) => b.matchCount - a.matchCount || a.key.localeCompare(b.key),
	);
}

export async function acceptRuleSuggestionForOwner(
	ownerId: string,
	input: { field: SuggestionField; value: string; entityId: string },
) {
	// Revalidate against current owner facts instead of trusting a browser candidate.
	const candidate = (await listRuleSuggestionsForOwner(ownerId)).find(
		(c) =>
			c.field === input.field &&
			c.value.toLowerCase() === input.value.trim().toLowerCase(),
	);
	if (!candidate) throw new Error("Suggestion no longer available");
	const condition: RuleCondition = {
		field: candidate.field,
		op: "equals",
		value: candidate.value,
	};
	const rule = await saveRuleForOwner(ownerId, {
		name: `${candidate.field}: ${candidate.value}`.slice(0, 120),
		enabled: true,
		priority: 100,
		match: "all",
		conditions: [condition],
		actions: { entityId: input.entityId },
	});
	const applied = await applyRulesToInbox(ownerId);
	return { ruleId: rule?.id, ...applied };
}
