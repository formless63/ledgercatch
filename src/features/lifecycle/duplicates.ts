/**
 * Pure duplicate-order detection (#6). The same purchase can arrive twice
 * through different channels (store parser + "Track this page", forwarded
 * receipt, manual entry). Candidates need a matching total (±1%) and date
 * (±3 days); item-title overlap and a different/generic source raise the
 * score.
 */
import { daysBetween, titleSimilarity } from "./items";

export type DuplicateSubject = {
	id: string;
	source: string;
	externalOrderId: string;
	merchantName: string | null;
	orderDate: string | null;
	currency: string | null;
	totalMinor: number | null;
	paymentMethodId: string | null;
	itemTitles: string[];
};

export type DuplicateCandidate = {
	orderId: string;
	otherId: string;
	score: number;
	reasons: string[];
};

/** Sources that can re-describe an order another channel already captured. */
export const GENERIC_SOURCES = new Set([
	"generic",
	"manual",
	"email",
	"import",
	"paperless",
	"agent",
	"upload",
]);

export const TOTAL_TOLERANCE = 0.01;
export const DATE_WINDOW_DAYS = 3;
export const MIN_SCORE = 0.55;

export function pairKey(a: string, b: string): [string, string] {
	return a < b ? [a, b] : [b, a];
}

/** Best item-title overlap between two orders, 0..1 (null if either has none). */
export function itemOverlap(a: string[], b: string[]): number | null {
	if (a.length === 0 || b.length === 0) return null;
	let matched = 0;
	for (const title of a) {
		const best = Math.max(...b.map((other) => titleSimilarity(title, other)));
		if (best >= 0.5) matched++;
	}
	return matched / Math.max(a.length, b.length);
}

/** Score one pair; null when it is not a plausible duplicate. */
export function scorePair(
	a: DuplicateSubject,
	b: DuplicateSubject,
): DuplicateCandidate | null {
	if (a.id === b.id) return null;
	if (a.source === b.source && a.externalOrderId === b.externalOrderId)
		return null;
	if (a.totalMinor == null || b.totalMinor == null) return null;
	if (a.totalMinor <= 0 || b.totalMinor <= 0) return null;
	if (
		a.currency &&
		b.currency &&
		a.currency.toUpperCase() !== b.currency.toUpperCase()
	)
		return null;
	const diff = Math.abs(a.totalMinor - b.totalMinor);
	const tolerance = Math.max(
		1,
		Math.max(a.totalMinor, b.totalMinor) * TOTAL_TOLERANCE,
	);
	if (diff > tolerance) return null;
	if (!a.orderDate || !b.orderDate) return null;
	const days = Math.abs(daysBetween(a.orderDate, b.orderDate));
	if (days > DATE_WINDOW_DAYS) return null;

	const differentChannel =
		a.source !== b.source ||
		GENERIC_SOURCES.has(a.source) ||
		GENERIC_SOURCES.has(b.source);
	if (!differentChannel) return null;

	const reasons: string[] = [];
	let score = 0;
	if (diff === 0) {
		score += 0.4;
		reasons.push("same total");
	} else {
		score += 0.3;
		reasons.push("total within 1%");
	}
	score += days === 0 ? 0.2 : 0.2 * (1 - days / (DATE_WINDOW_DAYS + 1));
	reasons.push(days === 0 ? "same date" : `${days}d apart`);

	const overlap = itemOverlap(a.itemTitles, b.itemTitles);
	if (overlap != null) {
		if (overlap === 0) return null;
		score += 0.3 * overlap;
		reasons.push(`${Math.round(overlap * 100)}% items overlap`);
	} else {
		score += 0.1;
		reasons.push("items unknown on one side");
	}
	if (a.paymentMethodId && a.paymentMethodId === b.paymentMethodId) {
		score += 0.1;
		reasons.push("same card");
	}
	if (a.source !== b.source) reasons.push(`${a.source} vs ${b.source}`);
	score = Math.min(1, Math.round(score * 100) / 100);
	if (score < MIN_SCORE) return null;
	return { orderId: a.id, otherId: b.id, score, reasons };
}

/**
 * All candidate pairs among `subjects` (or between `focus` and the rest),
 * minus dismissed pairs, highest score first. Pairs are reported once.
 */
export function detectDuplicates(input: {
	subjects: DuplicateSubject[];
	focusIds?: string[];
	dismissed?: Array<[string, string]>;
}): DuplicateCandidate[] {
	const dismissed = new Set(
		(input.dismissed ?? []).map(([a, b]) => pairKey(a, b).join("|")),
	);
	const focus = input.focusIds ? new Set(input.focusIds) : null;
	const seen = new Set<string>();
	const out: DuplicateCandidate[] = [];
	const list = input.subjects;
	for (let i = 0; i < list.length; i++) {
		const a = list[i] as DuplicateSubject;
		for (let j = i + 1; j < list.length; j++) {
			const b = list[j] as DuplicateSubject;
			if (focus && !focus.has(a.id) && !focus.has(b.id)) continue;
			const key = pairKey(a.id, b.id).join("|");
			if (seen.has(key) || dismissed.has(key)) continue;
			seen.add(key);
			const candidate = scorePair(a, b);
			if (candidate) out.push(candidate);
		}
	}
	return out.sort((x, y) => y.score - x.score);
}

/**
 * Which order should survive a merge: a specific store source beats a generic
 * one, then more items, then the earlier-seen order.
 */
export function suggestKeep(
	a: DuplicateSubject & { firstSeenAt?: string },
	b: DuplicateSubject & { firstSeenAt?: string },
): string {
	const generic = (s: DuplicateSubject) => GENERIC_SOURCES.has(s.source);
	if (generic(a) !== generic(b)) return generic(a) ? b.id : a.id;
	if (a.itemTitles.length !== b.itemTitles.length)
		return a.itemTitles.length > b.itemTitles.length ? a.id : b.id;
	return (a.firstSeenAt ?? "") <= (b.firstSeenAt ?? "") ? a.id : b.id;
}
