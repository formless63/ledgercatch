/** Budget period windows and threshold logic (pure). */
import type { BudgetPeriod } from "./schema";

export type BudgetLevel = "ok" | "threshold" | "exceeded";
export type AlertLevel = Exclude<BudgetLevel, "ok">;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number) => `${y}-${pad(m)}-01`;

/**
 * Calendar window containing `now` (UTC dates). `end` is exclusive.
 * `key` identifies the period for alert de-duplication.
 */
export function periodWindow(period: BudgetPeriod, now: Date) {
	const y = now.getUTCFullYear();
	const m = now.getUTCMonth() + 1;
	if (period === "month") {
		const next = m === 12 ? [y + 1, 1] : [y, m + 1];
		return {
			key: `${y}-${pad(m)}`,
			start: iso(y, m),
			end: iso(next[0] as number, next[1] as number),
		};
	}
	if (period === "quarter") {
		const q = Math.floor((m - 1) / 3) + 1;
		const startMonth = (q - 1) * 3 + 1;
		const endMonth = startMonth + 3;
		return {
			key: `${y}-Q${q}`,
			start: iso(y, startMonth),
			end: endMonth > 12 ? iso(y + 1, 1) : iso(y, endMonth),
		};
	}
	return { key: String(y), start: iso(y, 1), end: iso(y + 1, 1) };
}

export function budgetLevel(
	spentMinor: number,
	amountMinor: number,
	thresholdPct: number,
): BudgetLevel {
	if (amountMinor <= 0) return spentMinor > 0 ? "exceeded" : "ok";
	if (spentMinor > amountMinor) return "exceeded";
	// Integer comparison avoids float drift: spent/amount >= pct/100.
	if (spentMinor * 100 >= amountMinor * thresholdPct) return "threshold";
	return "ok";
}

export function progressPct(spentMinor: number, amountMinor: number) {
	if (amountMinor <= 0) return spentMinor > 0 ? 100 : 0;
	return Math.round((spentMinor / amountMinor) * 1000) / 10;
}

/**
 * Which alert (if any) to send now. Each level is sent at most once per
 * period; crossing from threshold to exceeded sends a second alert.
 */
export function alertToSend(input: {
	level: BudgetLevel;
	periodKey: string;
	alertedPeriod: string | null;
	alertedLevel: AlertLevel | null;
}): AlertLevel | null {
	if (input.level === "ok") return null;
	if (input.alertedPeriod !== input.periodKey) return input.level;
	if (input.alertedLevel === "exceeded") return null;
	if (input.level === "exceeded") return "exceeded";
	return input.alertedLevel === "threshold" ? null : "threshold";
}
