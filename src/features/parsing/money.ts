/**
 * Money parsing for store pages: "$1,234.56", "US $12.34", "€ 1.234,56",
 * "1 234,56 zł", "¥1,280", "R$126,59"… → integer minor units + ISO currency.
 *
 * Pure and deterministic. Never throws; returns `undefined` when unsure.
 */

/** ISO-4217 currencies whose minor unit is 0 (amounts are whole numbers). */
const ZERO_DECIMAL = new Set([
	"BIF",
	"CLP",
	"DJF",
	"GNF",
	"ISK",
	"JPY",
	"KMF",
	"KRW",
	"PYG",
	"RWF",
	"UGX",
	"VND",
	"VUV",
	"XAF",
	"XOF",
	"XPF",
]);
const THREE_DECIMAL = new Set([
	"BHD",
	"IQD",
	"JOD",
	"KWD",
	"LYD",
	"OMR",
	"TND",
]);

export const KNOWN_CURRENCIES = new Set([
	...ZERO_DECIMAL,
	...THREE_DECIMAL,
	"AED",
	"ARS",
	"AUD",
	"BGN",
	"BRL",
	"CAD",
	"CHF",
	"CNY",
	"COP",
	"CZK",
	"DKK",
	"EGP",
	"EUR",
	"GBP",
	"HKD",
	"HUF",
	"IDR",
	"ILS",
	"INR",
	"MAD",
	"MXN",
	"MYR",
	"NGN",
	"NOK",
	"NZD",
	"PEN",
	"PHP",
	"PKR",
	"PLN",
	"QAR",
	"RON",
	"RUB",
	"SAR",
	"SEK",
	"SGD",
	"THB",
	"TRY",
	"TWD",
	"UAH",
	"USD",
	"ZAR",
]);

/** Number of minor-unit digits for an ISO currency (default 2). */
export function minorDigits(currency: string | undefined): number {
	const code = currency?.toUpperCase();
	if (!code) return 2;
	if (ZERO_DECIMAL.has(code)) return 0;
	if (THREE_DECIMAL.has(code)) return 3;
	return 2;
}

/**
 * Currency markers, longest/most specific first. `ambiguous` markers ("$",
 * "¥", "kr") defer to the caller's hint when one is given.
 */
const MARKERS: Array<{ re: RegExp; code: string; ambiguous?: boolean }> = [
	{ re: /\bUS\s?\$|\bUSD\b|\$\s?US\b/i, code: "USD" },
	{ re: /\bCA\s?\$|\bC\s?\$|\bCAD\b|\$\s?CA\b/i, code: "CAD" },
	{ re: /\bAU\s?\$|\bA\s?\$|\bAUD\b/i, code: "AUD" },
	{ re: /\bNZ\s?\$|\bNZD\b/i, code: "NZD" },
	{ re: /\bHK\s?\$|\bHKD\b/i, code: "HKD" },
	{ re: /\bS\s?\$|\bSGD\b/i, code: "SGD" },
	{ re: /\bNT\s?\$|\bTWD\b/i, code: "TWD" },
	{ re: /\bMX\s?\$|\bMXN\b/i, code: "MXN" },
	{ re: /\bR\s?\$|\bBRL\b/i, code: "BRL" },
	{ re: /\bCN\s?¥|\bRMB\b|\bCNY\b|元/i, code: "CNY" },
	{ re: /\bJP\s?¥|\bJPY\b|円/i, code: "JPY" },
	{ re: /€|\bEUR\b/i, code: "EUR" },
	{ re: /£|\bGBP\b/i, code: "GBP" },
	{ re: /₹|\bINR\b|\bRs\.?(?=\s?\d)/i, code: "INR" },
	{ re: /₩|\bKRW\b/i, code: "KRW" },
	{ re: /₽|\bRUB\b|\bруб/i, code: "RUB" },
	{ re: /₺|\bTRY\b|\bTL\b/i, code: "TRY" },
	{ re: /₪|\bILS\b/i, code: "ILS" },
	{ re: /฿|\bTHB\b/i, code: "THB" },
	{ re: /₱|\bPHP\b/i, code: "PHP" },
	{ re: /₫|\bVND\b/i, code: "VND" },
	{ re: /₴|\bUAH\b/i, code: "UAH" },
	{ re: /zł|\bPLN\b/i, code: "PLN" },
	{ re: /Kč|\bCZK\b/i, code: "CZK" },
	{ re: /\bFt\b|\bHUF\b/i, code: "HUF" },
	{ re: /\blei\b|\bRON\b/i, code: "RON" },
	{ re: /\bCHF\b|\bFr\.\s?(?=\d)/i, code: "CHF" },
	{ re: /\bRM\s?(?=\d)|\bMYR\b/i, code: "MYR" },
	{ re: /\bRp\.?\s?(?=\d)|\bIDR\b/i, code: "IDR" },
	{ re: /\bAED\b|د\.إ/i, code: "AED" },
	{ re: /\bSAR\b|﷼/i, code: "SAR" },
	{ re: /\bZAR\b|(?:^|\s)R\s?(?=\d)/, code: "ZAR" },
	{ re: /\bSEK\b/i, code: "SEK" },
	{ re: /\bNOK\b/i, code: "NOK" },
	{ re: /\bDKK\b/i, code: "DKK" },
	{ re: /\bkr\.?(?![a-z])/i, code: "SEK", ambiguous: true },
	{ re: /¥|￥/, code: "JPY", ambiguous: true },
	{ re: /\$/, code: "USD", ambiguous: true },
];

/** Detects an ISO currency from symbols/codes in `text`. */
export function detectCurrency(
	text: string,
	hint?: string,
): string | undefined {
	const normalizedHint = normalizeCurrencyCode(hint);
	for (const marker of MARKERS) {
		if (!marker.re.test(text)) continue;
		if (marker.ambiguous && normalizedHint) {
			if (marker.code === "USD" && /\$/.test(text)) return normalizedHint;
			if (marker.code === "JPY" && /^(JPY|CNY)$/.test(normalizedHint))
				return normalizedHint;
			if (marker.code === "SEK" && /^(SEK|NOK|DKK|ISK)$/.test(normalizedHint))
				return normalizedHint;
		}
		return marker.code;
	}
	return undefined;
}

export function normalizeCurrencyCode(
	code: string | undefined | null,
): string | undefined {
	if (!code) return undefined;
	const upper = String(code).trim().toUpperCase();
	return /^[A-Z]{3}$/.test(upper) ? upper : undefined;
}

export type Money = { amountMinor: number; currency?: string };

export type ParseMoneyOptions = {
	/** Currency to assume for bare amounts / ambiguous symbols ("$", "¥", "kr"). */
	currency?: string;
	/** Treat "Free"/"FREE"/"Gratis"/"Kostenlos" as zero. */
	allowFree?: boolean;
};

const FREE_RE =
	/^\s*(free|gratis|kostenlos|gratuit|gratuite|envío gratis|free shipping)\b/i;

/** Matches one amount with optional currency markers on either side. */
const NUMBER_RE =
	/\d{1,3}(?:[ \u00a0\u202f'’]\d{3})+(?:[.,]\d+)?(?!\d)|\d[\d.,]*\d|\d/;

/**
 * Parses a single money amount out of `text`.
 *
 * Decimal-mark rules: when both "." and "," appear, the last one is the
 * decimal mark. When only one appears, it is a decimal mark if followed by
 * 1–2 digits (or 3 for 3-decimal currencies) and appears once; otherwise it
 * groups thousands. Spaces, NBSP and apostrophes always group thousands.
 */
export function parseMoney(
	input: string | number | null | undefined,
	options: ParseMoneyOptions = {},
): Money | undefined {
	if (input === null || input === undefined) return undefined;
	if (typeof input === "number") {
		if (!Number.isFinite(input)) return undefined;
		const currency = normalizeCurrencyCode(options.currency);
		return { amountMinor: toMinor(input, currency), currency };
	}
	const text = String(input)
		.replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
		.trim();
	if (!text) return undefined;
	if (options.allowFree && FREE_RE.test(text))
		return {
			amountMinor: 0,
			currency: normalizeCurrencyCode(options.currency),
		};

	const match = NUMBER_RE.exec(text);
	if (!match) return undefined;
	const currency =
		detectCurrency(text, options.currency) ??
		normalizeCurrencyCode(options.currency);
	const digits = minorDigits(currency);
	const raw = match[0];
	const decimal = parseDecimalString(raw, digits);
	if (decimal === undefined) return undefined;

	const before = text.slice(0, match.index);
	const after = text.slice(match.index + match[0].length);
	const negative =
		/[-−]\s?[^\d\s]{0,4}\s?$/.test(before) ||
		(/\(\s?[^\d\s()]{0,4}\s?$/.test(before) &&
			/^\s?[^\d\s()]{0,4}\s?\)/.test(after)) ||
		/^-/.test(after);
	const amountMinor = decimalToMinor(decimal, digits);
	return { amountMinor: negative ? -amountMinor : amountMinor, currency };
}

/** Like parseMoney but returns just minor units. */
export function parseMinor(
	input: string | number | null | undefined,
	options: ParseMoneyOptions = {},
): number | undefined {
	return parseMoney(input, options)?.amountMinor;
}

/**
 * Turns a localized number string into a canonical "1234.56" string, or
 * undefined if it cannot be read.
 */
export function parseDecimalString(
	raw: string,
	fractionDigits = 2,
): string | undefined {
	let s = raw.replace(/[\s\u00a0\u202f'’]/g, " ").trim();
	if (!/\d/.test(s)) return undefined;
	// Space-grouped thousands: "1 234,56" → "1234,56".
	s = s.replace(/(\d) (?=\d{3}\b)/g, "$1").replace(/\s+/g, "");
	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");
	let intPart: string;
	let fracPart = "";
	if (lastDot >= 0 && lastComma >= 0) {
		const decimalMark = lastDot > lastComma ? "." : ",";
		const idx = Math.max(lastDot, lastComma);
		intPart = s.slice(0, idx).replace(/[.,]/g, "");
		fracPart = s.slice(idx + 1);
		if (decimalMark === "." && fracPart.includes(",")) return undefined;
	} else if (lastDot >= 0 || lastComma >= 0) {
		const mark = lastDot >= 0 ? "." : ",";
		const parts = s.split(mark);
		const tail = parts[parts.length - 1] ?? "";
		const isDecimal =
			parts.length === 2 &&
			(tail.length <= 2 ||
				/^0+$/.test(parts[0] ?? "") ||
				(tail.length === 3 && fractionDigits === 3) ||
				(tail.length > 3 && tail.length <= 5));
		if (isDecimal) {
			intPart = parts[0] ?? "";
			fracPart = tail;
		} else {
			intPart = parts.join("");
		}
	} else {
		intPart = s;
	}
	if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return undefined;
	if (!intPart && !fracPart) return undefined;
	intPart = intPart.replace(/^0+(?=\d)/, "") || "0";
	return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** "1234.565" + 2 digits → 123457 (half-up). */
function decimalToMinor(decimal: string, digits: number): number {
	const [intPart = "0", fracRaw = ""] = decimal.split(".");
	const frac = fracRaw.padEnd(digits + 1, "0");
	const kept = frac.slice(0, digits);
	const next = Number(frac[digits] ?? "0");
	let value = Number(intPart) * 10 ** digits + (kept ? Number(kept) : 0);
	if (next >= 5) value += 1;
	return value;
}

/** Converts a decimal amount (number or numeric string) to minor units. */
export function toMinor(
	value: number | string,
	currency: string | undefined,
): number {
	const digits = minorDigits(currency);
	if (typeof value === "string") {
		const unsigned = value.trim().replace(/^-/, "");
		// Canonical machine decimals ("19.995") are never thousands-grouped.
		const decimal = /^\d+(\.\d+)?$/.test(unsigned)
			? unsigned
			: parseDecimalString(unsigned, digits);
		if (decimal === undefined) return Number.NaN;
		const minor = decimalToMinor(decimal, digits);
		return value.trim().startsWith("-") ? -minor : minor;
	}
	return Math.round(value * 10 ** digits);
}

/**
 * Global regex that finds money-looking substrings in free text (used by
 * text heuristics): a currency marker followed or preceded by an amount.
 */
export const MONEY_IN_TEXT_RE =
	/(?:[-−]\s?)?(?:(?:US|CA|C|AU|A|NZ|HK|S|NT|MX|R|CN)\s?\$|USD|EUR|GBP|CAD|AUD|JPY|CNY|CHF|PLN|SEK|NOK|DKK|INR|MYR|RM|[$€£¥￥₹₩₽₺₪฿₱])\s?\d[\d.,'\u00a0\u202f ]*\d(?:\s?(?:€|zł|kr|Kč))?|\d[\d.,'\u00a0\u202f ]*[.,]\d{2}\s?(?:€|zł|kr|Kč|EUR|USD|GBP|PLN|CHF|SEK)/g;

/** Returns all money substrings in `text`, in order. */
export function findMoneyStrings(text: string): string[] {
	return Array.from(text.matchAll(MONEY_IN_TEXT_RE), (m) => m[0].trim());
}
