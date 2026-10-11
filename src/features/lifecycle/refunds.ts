/**
 * Pure refund math: spread refunds over an order's allocations so spend,
 * insights and reimbursement claims can use net amounts. Allocations
 * themselves stay gross (computed by ledger/allocation.ts).
 */
import type { OrderStatus, ParsedOrder } from "#/features/parsing/types";
import type { RefundStatus } from "./schema";

export type RefundAllocationInput = {
	id: string;
	entityId: string;
	amountMinor: number;
	currency: string;
};

export type RefundInput = {
	amountMinor: number;
	currency: string;
	status: RefundStatus;
	orderItemId: string | null;
};

export type RefundItemInput = { id: string; entityId: string | null };

export type NetAllocation = RefundAllocationInput & {
	refundedMinor: number;
	/** Requested/approved but not yet received. */
	pendingRefundMinor: number;
	netMinor: number;
};

/** Which refund states reduce spend. Only money actually returned counts. */
export const NETTING_STATUSES: readonly RefundStatus[] = ["refunded"];

/**
 * Split one amount across allocations proportionally to their gross amount.
 * Rounding remainder goes to the primary (or largest) allocation. Never
 * assigns more than an allocation's remaining capacity.
 */
function spread(
	amount: number,
	targets: Array<{ id: string; capacity: number }>,
	primaryId: string | null,
): Map<string, number> {
	const out = new Map<string, number>();
	const open = targets.filter((t) => t.capacity > 0);
	const capacity = open.reduce((sum, t) => sum + t.capacity, 0);
	if (amount <= 0 || capacity <= 0) return out;
	const total = Math.min(amount, capacity);
	const anchor =
		open.find((t) => t.id === primaryId) ??
		[...open].sort((a, b) => b.capacity - a.capacity)[0];
	let assigned = 0;
	for (const target of open) {
		if (target.id === anchor?.id) continue;
		const share = Math.min(
			target.capacity,
			Math.round((total * target.capacity) / capacity),
		);
		out.set(target.id, share);
		assigned += share;
	}
	if (anchor) {
		const rest = Math.min(anchor.capacity, total - assigned);
		out.set(anchor.id, rest);
		assigned += rest;
	}
	// Anchor saturated: push what is left to anyone with spare capacity.
	let leftover = total - assigned;
	for (const target of open) {
		if (leftover <= 0) break;
		const spare = target.capacity - (out.get(target.id) ?? 0);
		if (spare <= 0) continue;
		const take = Math.min(spare, leftover);
		out.set(target.id, (out.get(target.id) ?? 0) + take);
		leftover -= take;
	}
	return out;
}

/**
 * Net each allocation of one order by its refunds. Item-level refunds land
 * on the item's entity; order-level refunds spread proportionally. Refunds in
 * another currency than the allocation are ignored (no FX here). Net never
 * goes below zero.
 */
export function netAllocations(input: {
	allocations: RefundAllocationInput[];
	refunds: RefundInput[];
	items?: RefundItemInput[];
	primaryEntityId: string | null;
}): NetAllocation[] {
	const { allocations, refunds, items = [], primaryEntityId } = input;
	const byEntity = new Map(allocations.map((a) => [a.entityId, a]));
	const primaryId =
		(primaryEntityId && byEntity.get(primaryEntityId)?.id) ?? null;
	const itemEntity = new Map(items.map((i) => [i.id, i.entityId]));
	const refunded = new Map<string, number>();
	const pending = new Map<string, number>();

	const apply = (bucket: Map<string, number>, refund: RefundInput) => {
		const eligible = allocations.filter(
			(a) => a.currency.toUpperCase() === refund.currency.toUpperCase(),
		);
		const capacityOf = (a: RefundAllocationInput) =>
			Math.max(0, a.amountMinor - (bucket.get(a.id) ?? 0));
		let targets = eligible;
		if (refund.orderItemId) {
			const entityId =
				itemEntity.get(refund.orderItemId) ?? primaryEntityId ?? null;
			const direct = eligible.find((a) => a.entityId === entityId);
			if (direct) targets = [direct];
		}
		let shares = spread(
			refund.amountMinor,
			targets.map((a) => ({ id: a.id, capacity: capacityOf(a) })),
			primaryId,
		);
		// Item entity fully netted already: overflow to the rest of the order.
		const placed = [...shares.values()].reduce((s, v) => s + v, 0);
		if (targets !== eligible && placed < refund.amountMinor) {
			for (const [id, value] of shares)
				bucket.set(id, (bucket.get(id) ?? 0) + value);
			shares = spread(
				refund.amountMinor - placed,
				eligible.map((a) => ({ id: a.id, capacity: capacityOf(a) })),
				primaryId,
			);
		}
		for (const [id, value] of shares)
			bucket.set(id, (bucket.get(id) ?? 0) + value);
	};

	for (const refund of refunds) {
		if (refund.amountMinor <= 0) continue;
		if (NETTING_STATUSES.includes(refund.status)) apply(refunded, refund);
		else apply(pending, refund);
	}
	return allocations.map((a) => {
		const refundedMinor = refunded.get(a.id) ?? 0;
		return {
			...a,
			refundedMinor,
			pendingRefundMinor: pending.get(a.id) ?? 0,
			netMinor: Math.max(0, a.amountMinor - refundedMinor),
		};
	});
}

export type ClaimDecision =
	| { allocationId: string; claimable: true; claimMinor: number }
	| {
			allocationId: string;
			claimable: false;
			reason: "fully_refunded" | "order_cancelled" | "refund_pending";
	  };

/**
 * Decide whether an allocation may still go into a reimbursement claim and
 * for how much. Fully refunded or cancelled orders are not claimable;
 * partially refunded ones are claimable at net. A pending refund that would
 * zero the allocation blocks the claim until it resolves.
 */
export function claimDecision(
	allocation: NetAllocation,
	orderStatus: OrderStatus | string,
): ClaimDecision {
	const id = allocation.id;
	if (allocation.netMinor <= 0)
		return { allocationId: id, claimable: false, reason: "fully_refunded" };
	if (orderStatus === "cancelled" && allocation.refundedMinor === 0)
		return { allocationId: id, claimable: false, reason: "order_cancelled" };
	if (allocation.pendingRefundMinor >= allocation.netMinor)
		return { allocationId: id, claimable: false, reason: "refund_pending" };
	return { allocationId: id, claimable: true, claimMinor: allocation.netMinor };
}

/* ───────────────────────── parser bridge ───────────────────────── */

/** What a parser or email ingester can report about one refund. */
export type ParsedRefund = {
	/** Store refund / reverse-order id. Strongly recommended for idempotency. */
	externalRefundId?: string;
	amountMinor: number;
	currency?: string;
	reason?: string;
	status?: RefundStatus;
	/** ISO date. */
	refundedAt?: string;
	/** Match a line by store item id or SKU when the refund is per item. */
	itemExternalId?: string;
	itemSku?: string;
};

/** Normalize free-text store refund states ("Refund successful", "Processing"…). */
export function refundStatusFromText(text: string | undefined): RefundStatus {
	const t = (text ?? "").toLowerCase();
	if (/(refunded|success|completed|credited|closed|paid)/.test(t))
		return "refunded";
	if (/(approved|accepted|agreed|processing)/.test(t)) return "approved";
	return "requested";
}

/**
 * A cancelled order with a known total and no explicit refund data implies a
 * full refund request. Parsers may opt in by calling this and passing the
 * result to recordRefundFromParsed; nothing does it automatically.
 */
export function impliedRefundFromParsedOrder(
	parsed: ParsedOrder,
): ParsedRefund | null {
	if (parsed.status !== "cancelled" || parsed.totalMinor == null) return null;
	if (parsed.totalMinor <= 0) return null;
	return {
		externalRefundId: `cancel:${parsed.externalOrderId}`,
		amountMinor: parsed.totalMinor,
		currency: parsed.currency,
		reason: parsed.statusText ?? "Order cancelled",
		status: "requested",
	};
}
