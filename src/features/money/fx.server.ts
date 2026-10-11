/**
 * FX rates: fetch ECB reference rates (no API key) into `fx_rates`, look
 * them up historically, convert amounts, and prepare USD-only connector
 * exports with a memo describing the conversion.
 *
 * Sources: ECB eurofxref XML (daily / last 90 days / full history) with
 * Frankfurter (api.frankfurter.app, which republishes ECB rates) as the
 * fallback and for arbitrary historical ranges.
 */
import { and, count, gte, inArray, lte, max, min, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	addDays,
	conversionMemo,
	convertMinorWithRate,
	FX_LOOKBACK_DAYS,
	type FxRateRow,
	minorToDecimal,
	parseEcbXml,
	parseFrankfurterJson,
	RateTable,
	type ResolvedRate,
} from "./fx";
import { fxRates } from "./schema";

const ECB_URLS = {
	daily: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
	hist90: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
	hist: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml",
} as const;
const FRANKFURTER_HOSTS = [
	"https://api.frankfurter.app",
	"https://api.frankfurter.dev/v1",
];
const FETCH_TIMEOUT_MS = 20_000;

export class FxUnavailableError extends Error {}

const today = () => new Date().toISOString().slice(0, 10);

async function fetchText(url: string) {
	const response = await fetch(url, {
		headers: { accept: "application/xml, application/json;q=0.9, */*;q=0.5" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
	return response.text();
}

export async function fetchEcbRates(
	kind: keyof typeof ECB_URLS,
): Promise<FxRateRow[]> {
	return parseEcbXml(await fetchText(ECB_URLS[kind]));
}

/** ECB rates via Frankfurter for a date range (inclusive). */
export async function fetchFrankfurterRange(
	from: string,
	to: string,
): Promise<FxRateRow[]> {
	let lastError: unknown;
	for (const host of FRANKFURTER_HOSTS) {
		try {
			const path = from === to ? `/${from}` : `/${from}..${to}`;
			const text = await fetchText(`${host}${path}?from=EUR`);
			return parseFrankfurterJson(JSON.parse(text));
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function storeRates(rows: FxRateRow[]) {
	let stored = 0;
	for (let i = 0; i < rows.length; i += 1000) {
		const chunk = rows.slice(i, i + 1000);
		if (!chunk.length) continue;
		await db
			.insert(fxRates)
			.values(chunk)
			.onConflictDoUpdate({
				target: [fxRates.date, fxRates.base, fxRates.quote],
				set: {
					rate: sql`excluded.rate`,
					source: sql`excluded.source`,
					fetchedAt: new Date(),
				},
			});
		stored += chunk.length;
	}
	return stored;
}

/**
 * Daily refresh. Empty table or `backfillDays` > 3 pulls the 90-day file;
 * longer backfills use Frankfurter ranges. ECB failures fall back to
 * Frankfurter.
 */
export async function refreshFxRates(options: { backfillDays?: number } = {}) {
	const [{ rows: existing = 0 } = { rows: 0 }] = await db
		.select({ rows: count() })
		.from(fxRates);
	const backfill = options.backfillDays ?? (existing === 0 ? 90 : 0);
	let rows: FxRateRow[] = [];
	let source = "ecb";
	try {
		if (backfill > 90) {
			source = "frankfurter";
			rows = await fetchFrankfurterRange(addDays(today(), -backfill), today());
		} else {
			rows = await fetchEcbRates(backfill > 3 ? "hist90" : "daily");
		}
	} catch (error) {
		source = "frankfurter";
		const from = addDays(today(), -Math.max(backfill, 7));
		try {
			rows = await fetchFrankfurterRange(from, today());
		} catch (fallbackError) {
			throw new Error(
				`FX fetch failed: ${error instanceof Error ? error.message : String(error)}; fallback: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
			);
		}
	}
	const stored = await storeRates(rows);
	const latest =
		rows
			.map((row) => row.date)
			.sort()
			.at(-1) ?? null;
	return { stored, latest, source };
}

const ensured = new Map<string, number>();

/**
 * Makes sure rates covering [from − look-back, to] exist, fetching the gap
 * from Frankfurter when they do not. Cheap when already covered.
 */
export async function ensureFxRates(from: string, to: string) {
	const start = addDays(from, -FX_LOOKBACK_DAYS);
	const end = to > today() ? today() : to;
	const key = `${start}|${end}`;
	const last = ensured.get(key);
	if (last && Date.now() - last < 6 * 3_600_000) return;
	const [range] = await db
		.select({ first: min(fxRates.date), last: max(fxRates.date) })
		.from(fxRates)
		.where(and(gte(fxRates.date, start), lte(fxRates.date, end)));
	const covered =
		range?.first != null &&
		range.last != null &&
		range.first <= addDays(start, FX_LOOKBACK_DAYS) &&
		range.last >= addDays(end, -4);
	if (!covered) {
		try {
			await storeRates(await fetchFrankfurterRange(start, end));
		} catch {
			// Offline / rate-limited: callers report missing rates instead.
		}
	}
	ensured.set(key, Date.now());
}

/** Rates for [from − look-back, to] (optionally only some currencies). */
export async function loadRateTable(
	from: string,
	to: string,
	currencies?: string[],
): Promise<RateTable> {
	const quotes = currencies
		? [...new Set(currencies.map((c) => c.toUpperCase()))].filter(
				(c) => c !== "EUR",
			)
		: undefined;
	if (quotes && !quotes.length) return new RateTable([]);
	const rows = await db
		.select()
		.from(fxRates)
		.where(
			and(
				gte(fxRates.date, addDays(from, -FX_LOOKBACK_DAYS)),
				lte(fxRates.date, to),
				...(quotes ? [inArray(fxRates.quote, quotes)] : []),
			),
		);
	return new RateTable(rows);
}

export type Conversion = {
	amountMinor: number;
	currency: string;
	rate: ResolvedRate;
};

/**
 * Converts minor units from one currency to another at the ECB reference
 * rate of `date` (or the latest earlier publication within a week).
 * Returns null when no rate is available even after fetching.
 */
export async function convertMinor(
	amountMinor: number,
	from: string,
	to: string,
	date: string,
	options: { fetchMissing?: boolean } = {},
): Promise<Conversion | null> {
	const source = from.toUpperCase();
	const target = to.toUpperCase();
	if (source === target)
		return {
			amountMinor,
			currency: target,
			rate: { rate: 1, date, source: "identity" },
		};
	let table = await loadRateTable(date, date, [source, target]);
	let rate = table.rate(source, target, date);
	if (!rate && options.fetchMissing !== false) {
		await ensureFxRates(date, date);
		table = await loadRateTable(date, date, [source, target]);
		rate = table.rate(source, target, date);
	}
	if (!rate) return null;
	return {
		amountMinor: convertMinorWithRate(amountMinor, source, target, rate.rate),
		currency: target,
		rate,
	};
}

export type ConnectorAmount = {
	/** Decimal string in the target currency ("50.78"). */
	amount: string;
	amountMinor: number;
	currency: string;
	converted: boolean;
	rate: ResolvedRate | null;
	/** "converted from EUR 46.97 @ 1.0812 (ECB 2026-10-03)" or null. */
	memo: string | null;
};

/**
 * Prepares an allocation for a single-currency connector (custom HTTP is
 * USD-only): converts at the order-date ECB rate and returns a memo note.
 * Throws FxUnavailableError when no rate can be found.
 */
export async function toConnectorCurrency(
	allocation: { amountMinor: number; currency: string },
	target: string,
	orderDate: string | null,
): Promise<ConnectorAmount> {
	const currency = allocation.currency.toUpperCase();
	const want = target.toUpperCase();
	if (currency === want)
		return {
			amount: minorToDecimal(allocation.amountMinor, want),
			amountMinor: allocation.amountMinor,
			currency: want,
			converted: false,
			rate: null,
			memo: null,
		};
	const date = orderDate ?? today();
	const conversion = await convertMinor(
		allocation.amountMinor,
		currency,
		want,
		date,
	);
	if (!conversion)
		throw new FxUnavailableError(
			`No ${currency}→${want} reference rate available for ${date}`,
		);
	return {
		amount: minorToDecimal(conversion.amountMinor, want),
		amountMinor: conversion.amountMinor,
		currency: want,
		converted: true,
		rate: conversion.rate,
		memo: conversionMemo({
			amountMinor: allocation.amountMinor,
			from: currency,
			rate: conversion.rate,
		}),
	};
}

export async function getFxStatus() {
	const [row] = await db
		.select({
			rows: count(),
			first: min(fxRates.date),
			last: max(fxRates.date),
			fetchedAt: max(fxRates.fetchedAt),
		})
		.from(fxRates);
	const quotes = await db
		.selectDistinct({ quote: fxRates.quote })
		.from(fxRates)
		.where(sql`${fxRates.date} = (select max(date) from ${fxRates})`);
	return {
		rows: row?.rows ?? 0,
		first: row?.first ?? null,
		last: row?.last ?? null,
		fetchedAt: row?.fetchedAt ? new Date(row.fetchedAt).toISOString() : null,
		currencies: ["EUR", ...quotes.map((q) => q.quote).sort()],
	};
}
