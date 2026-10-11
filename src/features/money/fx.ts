/**
 * Historical FX (pure, client-safe): ECB/Frankfurter feed parsing, a rate
 * table with weekend/holiday look-back and cross rates through EUR, and
 * minor-unit conversion that respects each currency's exponent.
 */
import { minorDigits, normalizeCurrencyCode } from "#/features/parsing/money";

export type FxRateRow = {
	date: string;
	base: string;
	quote: string;
	rate: number;
	source: string;
};

export type ResolvedRate = {
	/** 1 `from` = rate `to`. */
	rate: number;
	/** Date of the reference rate actually used (≤ requested date). */
	date: string;
	source: string;
};

/** Days to look back for a published rate (weekends, TARGET holidays). */
export const FX_LOOKBACK_DAYS = 7;

export const FX_SOURCE_LABELS: Record<string, string> = {
	ecb: "ECB",
	frankfurter: "ECB",
};

/* ───────────────────────── feed parsing ───────────────────────── */

/**
 * ECB eurofxref XML (daily, hist-90d or full history):
 * `<Cube time="2026-10-03"><Cube currency="USD" rate="1.0812"/>…</Cube>`.
 */
export function parseEcbXml(xml: string): FxRateRow[] {
	const rows: FxRateRow[] = [];
	const dayRe =
		/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
	for (const day of xml.matchAll(dayRe)) {
		const date = day[1] ?? "";
		const rateRe =
			/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g;
		for (const match of (day[2] ?? "").matchAll(rateRe)) {
			const rate = Number(match[2]);
			if (match[1] && Number.isFinite(rate) && rate > 0)
				rows.push({ date, base: "EUR", quote: match[1], rate, source: "ecb" });
		}
	}
	return rows;
}

/**
 * Frankfurter JSON: single day `{base, date, rates: {USD: 1.08}}` or time
 * series `{base, start_date, end_date, rates: {"2026-10-03": {USD: 1.08}}}`.
 */
export function parseFrankfurterJson(json: unknown): FxRateRow[] {
	if (!json || typeof json !== "object") return [];
	const body = json as {
		base?: string;
		date?: string;
		rates?: Record<string, number | Record<string, number>>;
	};
	const base = normalizeCurrencyCode(body.base) ?? "EUR";
	const rows: FxRateRow[] = [];
	const push = (date: string, rates: Record<string, unknown>) => {
		for (const [quote, value] of Object.entries(rates)) {
			const rate = Number(value);
			const code = normalizeCurrencyCode(quote);
			if (code && Number.isFinite(rate) && rate > 0)
				rows.push({ date, base, quote: code, rate, source: "frankfurter" });
		}
	};
	if (!body.rates) return rows;
	if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
		push(body.date, body.rates as Record<string, unknown>);
		return rows;
	}
	for (const [date, rates] of Object.entries(body.rates))
		if (/^\d{4}-\d{2}-\d{2}$/.test(date) && rates && typeof rates === "object")
			push(date, rates as Record<string, unknown>);
	return rows;
}

/* ───────────────────────── rate table ───────────────────────── */

export function addDays(isoDate: string, days: number): string {
	const date = new Date(`${isoDate}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
	return Math.round(
		(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
			86_400_000,
	);
}

/**
 * In-memory rates keyed by date. Cross rates go through the pivot (EUR for
 * ECB data): from→to = (pivot→to) / (pivot→from).
 */
export class RateTable {
	/** quote → sorted [date, rate, source] for base = pivot. */
	private readonly byQuote = new Map<string, Array<[string, number, string]>>();
	readonly pivot: string;

	constructor(rows: FxRateRow[], pivot = "EUR") {
		this.pivot = pivot;
		for (const row of rows) {
			if (row.base === pivot)
				this.add(row.quote, row.date, row.rate, row.source);
			else if (row.quote === pivot)
				this.add(row.base, row.date, 1 / row.rate, row.source);
		}
		for (const list of this.byQuote.values())
			list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	}

	private add(quote: string, date: string, rate: number, source: string) {
		const list = this.byQuote.get(quote) ?? [];
		list.push([date, rate, source]);
		this.byQuote.set(quote, list);
	}

	get size() {
		let total = 0;
		for (const list of this.byQuote.values()) total += list.length;
		return total;
	}

	/** Pivot→quote rate on the latest date ≤ `date` within the look-back window. */
	private pivotRate(quote: string, date: string, lookback: number) {
		if (quote === this.pivot) return { rate: 1, date, source: "" };
		const list = this.byQuote.get(quote);
		if (!list?.length) return null;
		let lo = 0;
		let hi = list.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const entry = list[mid];
			if (entry && entry[0] <= date) {
				found = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		const entry = found >= 0 ? list[found] : undefined;
		if (!entry || daysBetween(entry[0], date) > lookback) return null;
		return { rate: entry[1], date: entry[0], source: entry[2] };
	}

	rate(
		from: string,
		to: string,
		date: string,
		lookback = FX_LOOKBACK_DAYS,
	): ResolvedRate | null {
		const a = from.toUpperCase();
		const b = to.toUpperCase();
		if (a === b) return { rate: 1, date, source: "identity" };
		const fromRate = this.pivotRate(a, date, lookback);
		const toRate = this.pivotRate(b, date, lookback);
		if (!fromRate || !toRate) return null;
		const used = [fromRate, toRate].filter((r) => r.source);
		const rateDate = used.map((r) => r.date).sort()[0] ?? fromRate.date;
		return {
			rate: toRate.rate / fromRate.rate,
			date: rateDate,
			source: used[0]?.source ?? "ecb",
		};
	}
}

/* ───────────────────────── conversion ───────────────────────── */

/** Exponent used for stored minor units (matches the parsers). */
export function exponentOf(currency: string): number {
	return minorDigits(currency);
}

/**
 * Converts minor units with exponent handling:
 * 4697 EUR (exp 2) @ 1.0812 → 5078 USD; 1200 JPY (exp 0) @ 0.0067 → 804 USD cents.
 * Rounds half away from zero.
 */
export function convertMinorWithRate(
	amountMinor: number,
	from: string,
	to: string,
	rate: number,
): number {
	if (from.toUpperCase() === to.toUpperCase()) return amountMinor;
	const scale = 10 ** (exponentOf(to) - exponentOf(from));
	const value = amountMinor * rate * scale;
	// Guard float noise (e.g. 4697 × 1.0812 = 5078.3964…) before rounding.
	const rounded = Math.round(Math.abs(value) + 1e-9);
	return value < 0 ? -rounded : rounded;
}

/** Plain decimal string ("46.97", "1200", "-0.05") for minor units. */
export function minorToDecimal(minor: number, currency: string): string {
	const exp = exponentOf(currency);
	const negative = minor < 0;
	const digits = String(Math.abs(Math.trunc(minor)));
	if (exp === 0) return `${negative ? "-" : ""}${digits}`;
	const padded = digits.padStart(exp + 1, "0");
	return `${negative ? "-" : ""}${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
}

/** Human rate: 4 decimals for ≥ 0.1, else 4 significant digits. */
export function formatRate(rate: number): string {
	if (!Number.isFinite(rate)) return String(rate);
	if (rate >= 0.1) return rate.toFixed(4);
	return Number(rate.toPrecision(4)).toString();
}

/** "converted from EUR 46.97 @ 1.0812 (ECB 2026-10-03)" */
export function conversionMemo(input: {
	amountMinor: number;
	from: string;
	rate: ResolvedRate;
}): string {
	const label =
		FX_SOURCE_LABELS[input.rate.source] ?? input.rate.source.toUpperCase();
	return `converted from ${input.from.toUpperCase()} ${minorToDecimal(input.amountMinor, input.from)} @ ${formatRate(input.rate.rate)} (${label} ${input.rate.date})`;
}
