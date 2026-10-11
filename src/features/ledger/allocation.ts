import type { ReimbursementStatus } from "./schema";

export type AllocationOrderInput = {
	currency: string | null;
	entityId: string | null;
	totalMinor: number | null;
	subtotalMinor: number | null;
	shippingMinor: number | null;
	taxMinor: number | null;
	discountMinor: number | null;
	categoryId: string | null;
	reimbursableOverride: boolean | null;
};

export type AllocationItemInput = {
	totalMinor: number | null;
	entityId: string | null;
	categoryId: string | null;
};

export type ExistingAllocation = {
	entityId: string;
	reimbursementStatus: ReimbursementStatus;
};

export type ComputedAllocation = {
	entityId: string;
	categoryId: string | null;
	amountMinor: number;
	currency: string;
	reimbursable: boolean;
	reimbursementStatus: ReimbursementStatus;
};

/** Order total, falling back to items + charges when the store did not show one. */
export function effectiveTotal(
	order: AllocationOrderInput,
	items: AllocationItemInput[],
): number {
	if (order.totalMinor != null) return order.totalMinor;
	const itemSum = items.reduce((sum, item) => sum + (item.totalMinor ?? 0), 0);
	const base = order.subtotalMinor ?? itemSum;
	return (
		base +
		(order.shippingMinor ?? 0) +
		(order.taxMinor ?? 0) -
		Math.abs(order.discountMinor ?? 0)
	);
}

/**
 * Splits an order across entities: each entity gets the share of the order
 * total proportional to its items; rounding remainder goes to the primary
 * entity. Reimbursement status is preserved for entities that stay
 * reimbursable.
 */
export function computeAllocations(input: {
	order: AllocationOrderInput;
	items: AllocationItemInput[];
	payingEntityId: string | null;
	existing: ExistingAllocation[];
}): ComputedAllocation[] {
	const { order, items, payingEntityId, existing } = input;
	const primary =
		order.entityId ?? items.find((item) => item.entityId)?.entityId ?? null;
	if (!primary) return [];

	const currency = order.currency ?? "USD";
	const total = effectiveTotal(order, items);

	const weights = new Map<string, number>();
	const categoryByEntity = new Map<string, string | null>();
	let weightSum = 0;
	for (const item of items) {
		const entityId = item.entityId ?? primary;
		const weight = Math.max(0, item.totalMinor ?? 0);
		weights.set(entityId, (weights.get(entityId) ?? 0) + weight);
		if (!categoryByEntity.has(entityId) && item.categoryId)
			categoryByEntity.set(entityId, item.categoryId);
		weightSum += weight;
	}

	const amounts = new Map<string, number>();
	if (weightSum <= 0 || weights.size <= 1) {
		amounts.set(primary, total);
	} else {
		let assigned = 0;
		for (const [entityId, weight] of weights) {
			if (entityId === primary) continue;
			const share = Math.round((total * weight) / weightSum);
			amounts.set(entityId, share);
			assigned += share;
		}
		amounts.set(primary, total - assigned);
	}

	const previous = new Map(
		existing.map((row) => [row.entityId, row.reimbursementStatus]),
	);
	const result: ComputedAllocation[] = [];
	for (const [entityId, amountMinor] of amounts) {
		const reimbursable =
			order.reimbursableOverride ??
			(payingEntityId != null && payingEntityId !== entityId);
		const prior = previous.get(entityId);
		let reimbursementStatus: ReimbursementStatus = "none";
		if (reimbursable)
			reimbursementStatus = prior && prior !== "none" ? prior : "pending";
		result.push({
			entityId,
			categoryId:
				entityId === primary
					? (order.categoryId ?? categoryByEntity.get(entityId) ?? null)
					: (categoryByEntity.get(entityId) ?? null),
			amountMinor,
			currency,
			reimbursable,
			reimbursementStatus,
		});
	}
	return result.sort((a, b) =>
		a.entityId === primary ? -1 : b.entityId === primary ? 1 : 0,
	);
}
