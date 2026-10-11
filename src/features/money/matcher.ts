/**
 * Statement transaction ↔ order matcher (pure, deterministic).
 *
 * Signals: same card (payment method) when both sides know it — a known
 * mismatch vetoes; amount equal (or within FX tolerance when the charge is in
 * another currency than the order); date window −2..+7 days from the order
 * date; merchant similarity. Also finds split shipments (one order ↔ several
 * charges summing to its total) and refunds (negative amounts ↔ orders).
 *
 * The matcher only *suggests*; confirmation is always a user action.
 */
import { daysBetween } from "./fx";
import { merchantSimilarity } from "./merchant";
import type { MatchKind } from "./schema";

export type MatchTransaction = {
	id: string;
	date: string;
	/** Charges positive, credits negative. */
	amountMinor: number;
	currency: string;
	merchantKey: string;
	paymentMethodId: string | null;
	kind: string;
};

export type MatchOrder = {
	id: string;
	date: string;
	totalMinor: number;
	currency: string;
	merchantKey: string;
	paymentMethodId: string | null;
	status: string;
	/** Line totals (for partial refunds of one item). */
	itemTotals?: number[];
};

/** Converts minor units between currencies at a date; null when no rate. */
export type Converter = (
	amountMinor: number,
	from: string,
	to: string,
	date: string,
) => number | null;

export type MatchSuggestion = {
	orderId: string;
	transactionIds: string[];
	kind: MatchKind;
	score: number;
	reasons: string[];
};

export const MATCH_THRESHOLD = 0.55;
export const DATE_WINDOW = { before: 2, after: 7 } as const;
export const SPLIT_WINDOW_DAYS = 30;
export const REFUND_WINDOW_DAYS = 120;
/** Card FX fees / bank rates vs ECB reference: accept ±3.5%. */
export const FX_TOLERANCE = 0.035;

const round = (value: number) => Math.round(value * 1000) / 1000;

type Scored = { score: number; reasons: string[] };

function cardScore(tx: MatchTransaction, order: MatchOrder): Scored | null {
	if (tx.paymentMethodId && order.paymentMethodId) {
		if (tx.paymentMethodId !== order.paymentMethodId) return null;
		return { score: 0.1, reasons: ["same card"] };
	}
	return { score: 0, reasons: [] };
}

function merchantScore(tx: MatchTransaction, order: MatchOrder): Scored {
	const similarity = merchantSimilarity(tx.merchantKey, order.merchantKey);
	if (similarity <= 0) return { score: 0, reasons: [] };
	return {
		score: 0.2 * similarity,
		reasons:
			similarity >= 0.99
				? [`merchant ${order.merchantKey}`]
				: similarity >= 0.5
					? [`merchant ≈ ${order.merchantKey}`]
					: [],
	};
}

/**
 * Order amount expressed in the transaction's currency, plus the allowed
 * absolute difference.
 */
function expectedAmount(
	amountMinor: number,
	order: MatchOrder,
	txCurrency: string,
	convert?: Converter,
): { amount: number; tolerance: number; fx: boolean } | null {
	if (order.currency.toUpperCase() === txCurrency.toUpperCase())
		return { amount: amountMinor, tolerance: 1, fx: false };
	const converted = convert?.(
		amountMinor,
		order.currency,
		txCurrency,
		order.date,
	);
	if (converted == null) return null;
	return {
		amount: converted,
		tolerance: Math.max(2, Math.abs(converted) * FX_TOLERANCE),
		fx: true,
	};
}

function amountScore(
	actual: number,
	expected: { amount: number; tolerance: number; fx: boolean },
	weight = 0.45,
): Scored | null {
	const diff = Math.abs(actual - expected.amount);
	if (diff > expected.tolerance) return null;
	if (!expected.fx) return { score: weight, reasons: ["amount equal"] };
	const ratio = expected.amount ? diff / Math.abs(expected.amount) : 0;
	return {
		score: weight * (0.9 - (ratio / FX_TOLERANCE) * 0.4),
		reasons: [`amount within ${(ratio * 100).toFixed(1)}% after FX`],
	};
}

function dateScore(delta: number): Scored | null {
	if (delta < -DATE_WINDOW.before || delta > DATE_WINDOW.after) return null;
	if (delta >= 0 && delta <= 2)
		return { score: 0.25, reasons: [delta === 0 ? "same day" : `+${delta}d`] };
	if (delta < 0) return { score: 0.15, reasons: [`${delta}d`] };
	return { score: 0.25 - (delta - 2) * 0.03, reasons: [`+${delta}d`] };
}

/** Scores one charge against one order; null when a hard constraint fails. */
export function scoreChargeMatch(
	tx: MatchTransaction,
	order: MatchOrder,
	convert?: Converter,
): Scored | null {
	if (tx.amountMinor <= 0 || order.totalMinor <= 0) return null;
	const card = cardScore(tx, order);
	if (!card) return null;
	const date = dateScore(daysBetween(order.date, tx.date));
	if (!date) return null;
	const expected = expectedAmount(
		order.totalMinor,
		order,
		tx.currency,
		convert,
	);
	if (!expected) return null;
	const amount = amountScore(tx.amountMinor, expected);
	if (!amount) return null;
	const merchant = merchantScore(tx, order);
	return {
		score: round(amount.score + date.score + merchant.score + card.score),
		reasons: [
			...amount.reasons,
			...date.reasons,
			...merchant.reasons,
			...card.reasons,
		],
	};
}

/** Scores a credit (negative amount) as a refund of an order. */
export function scoreRefundMatch(
	tx: MatchTransaction,
	order: MatchOrder,
	convert?: Converter,
): Scored | null {
	if (tx.amountMinor >= 0 || order.totalMinor <= 0) return null;
	const card = cardScore(tx, order);
	if (!card) return null;
	const delta = daysBetween(order.date, tx.date);
	if (delta < -DATE_WINDOW.before || delta > REFUND_WINDOW_DAYS) return null;
	const merchant = merchantScore(tx, order);
	if (merchantSimilarity(tx.merchantKey, order.merchantKey) < 0.6) return null;
	const refund = -tx.amountMinor;
	const full = expectedAmount(order.totalMinor, order, tx.currency, convert);
	if (!full) return null;
	let amount: Scored | null = amountScore(refund, full, 0.4);
	if (amount) amount.reasons = ["full refund"];
	if (!amount)
		for (const itemTotal of order.itemTotals ?? []) {
			const item = expectedAmount(itemTotal, order, tx.currency, convert);
			const hit = item && amountScore(refund, item, 0.3);
			if (hit) {
				amount = { score: hit.score, reasons: ["refund of one item"] };
				break;
			}
		}
	if (!amount && refund < full.amount + full.tolerance)
		amount = { score: 0.12, reasons: ["partial refund"] };
	if (!amount) return null;
	const statusBonus =
		order.status === "returned" || order.status === "cancelled"
			? { score: 0.15, reasons: [`order ${order.status}`] }
			: { score: 0, reasons: [] };
	const recency = delta <= 45 ? 0.1 : 0.05;
	return {
		score: round(
			amount.score + merchant.score + card.score + statusBonus.score + recency,
		),
		reasons: [
			...amount.reasons,
			`+${delta}d`,
			...merchant.reasons,
			...card.reasons,
			...statusBonus.reasons,
		],
	};
}

/**
 * Smallest-first search for 2..maxParts charges summing to `target`
 * (within tolerance). Candidates are tried in date order; bounded work.
 */
export function findSplitSubset(
	candidates: Array<{ id: string; amountMinor: number }>,
	target: number,
	tolerance: number,
	maxParts = 5,
): string[] | null {
	const list = candidates.slice(0, 14);
	let best: string[] | null = null;
	let steps = 0;
	const walk = (start: number, sum: number, chosen: string[]) => {
		if (best || steps++ > 50_000) return;
		if (chosen.length >= 2 && Math.abs(sum - target) <= tolerance) {
			best = [...chosen];
			return;
		}
		if (chosen.length >= maxParts || sum > target + tolerance) return;
		for (let i = start; i < list.length; i++) {
			const candidate = list[i];
			if (!candidate) continue;
			chosen.push(candidate.id);
			walk(i + 1, sum + candidate.amountMinor, chosen);
			chosen.pop();
			if (best) return;
		}
	};
	walk(0, 0, []);
	return best;
}

export function matchTransactions(input: {
	transactions: MatchTransaction[];
	orders: MatchOrder[];
	convert?: Converter;
	/** "txId|orderId" pairs the user rejected. */
	rejected?: Set<string>;
	/** Orders whose charge is already confirmed (still eligible for refunds). */
	ordersWithCharge?: Set<string>;
	threshold?: number;
}): MatchSuggestion[] {
	const { transactions, orders, convert } = input;
	const rejected = input.rejected ?? new Set<string>();
	const threshold = input.threshold ?? MATCH_THRESHOLD;
	const usable = (txId: string, orderId: string) =>
		!rejected.has(`${txId}|${orderId}`);

	const charges = transactions.filter(
		(tx) => tx.amountMinor > 0 && (tx.kind === "charge" || tx.kind === "other"),
	);
	const credits = transactions.filter(
		(tx) => tx.amountMinor < 0 && tx.kind === "credit",
	);
	const charged = input.ordersWithCharge ?? new Set<string>();
	const purchaseOrders = orders.filter(
		(order) => order.status !== "cancelled" && !charged.has(order.id),
	);

	/* 1. single charge ↔ order, greedy by score */
	const pairs: Array<{ tx: MatchTransaction; order: MatchOrder } & Scored> = [];
	for (const tx of charges)
		for (const order of purchaseOrders) {
			if (!usable(tx.id, order.id)) continue;
			const scored = scoreChargeMatch(tx, order, convert);
			if (scored && scored.score >= threshold)
				pairs.push({ tx, order, ...scored });
		}
	pairs.sort(
		(a, b) =>
			b.score - a.score ||
			Math.abs(daysBetween(a.order.date, a.tx.date)) -
				Math.abs(daysBetween(b.order.date, b.tx.date)) ||
			(a.tx.id < b.tx.id ? -1 : 1),
	);
	const usedTx = new Set<string>();
	const usedOrder = new Set<string>();
	const suggestions: MatchSuggestion[] = [];
	for (const pair of pairs) {
		if (usedTx.has(pair.tx.id) || usedOrder.has(pair.order.id)) continue;
		const rivals = pairs.filter(
			(other) =>
				other !== pair &&
				!usedOrder.has(other.order.id) &&
				!usedTx.has(other.tx.id) &&
				(other.tx.id === pair.tx.id || other.order.id === pair.order.id) &&
				pair.score - other.score < 0.05,
		).length;
		usedTx.add(pair.tx.id);
		usedOrder.add(pair.order.id);
		suggestions.push({
			orderId: pair.order.id,
			transactionIds: [pair.tx.id],
			kind: "single",
			score: rivals ? round(Math.max(threshold, pair.score - 0.1)) : pair.score,
			reasons: rivals
				? [...pair.reasons, `${rivals + 1} similar candidates`]
				: pair.reasons,
		});
	}

	/* 2. split shipments: unmatched order ↔ several charges */
	for (const order of purchaseOrders) {
		if (usedOrder.has(order.id) || order.totalMinor <= 0) continue;
		const candidates = charges
			.filter((tx) => {
				if (usedTx.has(tx.id) || !usable(tx.id, order.id)) return false;
				if (
					tx.paymentMethodId &&
					order.paymentMethodId &&
					tx.paymentMethodId !== order.paymentMethodId
				)
					return false;
				const delta = daysBetween(order.date, tx.date);
				if (delta < -DATE_WINDOW.before || delta > SPLIT_WINDOW_DAYS)
					return false;
				return merchantSimilarity(tx.merchantKey, order.merchantKey) >= 0.6;
			})
			.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
		if (candidates.length < 2) continue;
		const currency = candidates[0]?.currency ?? order.currency;
		const sameCurrency = candidates.filter((tx) => tx.currency === currency);
		const target = expectedAmount(order.totalMinor, order, currency, convert);
		if (!target) continue;
		const subset = findSplitSubset(
			sameCurrency.filter(
				(tx) => tx.amountMinor < target.amount + target.tolerance,
			),
			target.amount,
			target.tolerance,
		);
		if (!subset) continue;
		const chosen = sameCurrency.filter((tx) => subset.includes(tx.id));
		const merchant = Math.min(
			...chosen.map((tx) =>
				merchantSimilarity(tx.merchantKey, order.merchantKey),
			),
		);
		const sameCard = chosen.every(
			(tx) =>
				tx.paymentMethodId && tx.paymentMethodId === order.paymentMethodId,
		);
		const score = round(
			(target.fx ? 0.3 : 0.38) + 0.15 + 0.2 * merchant + (sameCard ? 0.1 : 0),
		);
		if (score < threshold) continue;
		for (const id of subset) usedTx.add(id);
		usedOrder.add(order.id);
		suggestions.push({
			orderId: order.id,
			transactionIds: subset,
			kind: "split",
			score,
			reasons: [
				`${subset.length} charges sum to order total`,
				`merchant ${order.merchantKey}`,
				...(sameCard ? ["same card"] : []),
			],
		});
	}

	/* 3. refunds: credits ↔ orders (orders may already have their charge) */
	const refundPairs: Array<
		{ tx: MatchTransaction; order: MatchOrder } & Scored
	> = [];
	for (const tx of credits)
		for (const order of orders) {
			if (!usable(tx.id, order.id)) continue;
			const scored = scoreRefundMatch(tx, order, convert);
			if (scored && scored.score >= threshold)
				refundPairs.push({ tx, order, ...scored });
		}
	refundPairs.sort((a, b) => b.score - a.score || (a.tx.id < b.tx.id ? -1 : 1));
	const usedCredit = new Set<string>();
	for (const pair of refundPairs) {
		if (usedCredit.has(pair.tx.id)) continue;
		usedCredit.add(pair.tx.id);
		suggestions.push({
			orderId: pair.order.id,
			transactionIds: [pair.tx.id],
			kind: "refund",
			score: pair.score,
			reasons: pair.reasons,
		});
	}
	return suggestions;
}
