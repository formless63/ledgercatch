import { findMoneyStrings, type ParseMoneyOptions, parseMoney } from "./money";

/** Collapses whitespace (incl. NBSP, narrow NBSP) and strips zero-width chars. */
export function cleanText(value: string | null | undefined): string {
	if (!value) return "";
	return value.replace(/[​-‏⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

/** Escapes a string for use inside a RegExp. */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the first money amount that follows a label within `window` chars,
 * e.g. moneyAfterLabel(text, /grand total/i). Returns minor units.
 */
export function moneyAfterLabel(
	text: string,
	label: RegExp,
	options: ParseMoneyOptions & { window?: number; last?: boolean } = {},
): { amountMinor: number; currency?: string } | undefined {
	const flags = label.flags.includes("g") ? label.flags : `${label.flags}g`;
	const re = new RegExp(label.source, flags);
	const hits: Array<{ amountMinor: number; currency?: string }> = [];
	for (const match of text.matchAll(re)) {
		const start = (match.index ?? 0) + match[0].length;
		const tail = text.slice(start, start + (options.window ?? 48));
		if (
			options.allowFree &&
			/^\s*[:\-–]?\s*(free|gratis|kostenlos)\b/i.test(tail)
		) {
			hits.push({ amountMinor: 0, currency: options.currency });
			if (!options.last) break;
			continue;
		}
		const money = findMoneyStrings(tail)[0];
		if (!money) continue;
		// Money must come before any other label-ish word run that ends with ':'.
		const idx = tail.indexOf(money);
		if (/[A-Za-z]{3,}[^:]*:/.test(tail.slice(0, idx).replace(/^\s*:/, "")))
			continue;
		const parsed = parseMoney(money, options);
		if (!parsed) continue;
		const negativeBefore = /[-−]\s*$/.test(tail.slice(0, idx));
		hits.push(
			negativeBefore && parsed.amountMinor > 0
				? { ...parsed, amountMinor: -parsed.amountMinor }
				: parsed,
		);
		if (!options.last) break;
	}
	return options.last ? hits[hits.length - 1] : hits[0];
}

/** "Visa ending in 4821", "•••• 4821", "**** 1234", "xxxx-1234" → "4821". */
export function extractLast4(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const m =
		/(?:ending|ends|endet|endend|terminant|terminada)\s+(?:in|with|mit|par|en)\s*:?\s*(\d{4})\b/i.exec(
			text,
		) ??
		/(?:[*•·xX]{2,}|\.{3,})[\s-]*(\d{4})\b/.exec(text) ??
		/(?:^|\s)[*•xX]-(\d{4})\b/.exec(text) ??
		/last\s+(?:4\s+)?digits:?\s*(\d{4})\b/i.exec(text) ??
		/(?:mit der endung|endet auf|endend auf)\s*(\d{4})\b/i.exec(text);
	return m?.[1];
}

export type TrackingHit = { carrier?: string; trackingNumber: string };

const TRACKING_PATTERNS: Array<{
	re: RegExp;
	carrier?: string;
	near?: RegExp;
}> = [
	{ re: /\b1Z[0-9A-Z]{16}\b/g, carrier: "UPS" },
	{ re: /\b(?:9[2-5]\d{20,24})\b/g, carrier: "USPS" },
	{ re: /\b[A-Z]{2}\d{9}US\b/g, carrier: "USPS" },
	{ re: /\bTBA\d{12}\b/g, carrier: "Amazon Logistics" },
	{ re: /\bLP\d{14}\b/g, carrier: "Cainiao" },
	{ re: /\b[A-Z]{2}\d{9}(?!US)[A-Z]{2}\b/g },
	{ re: /\b\d{12}(?:\d{3})?\b/g, carrier: "FedEx", near: /fedex/i },
	{ re: /\b\d{10}\b/g, carrier: "DHL", near: /\bdhl\b/i },
];

/** Finds carrier tracking numbers in free text. */
export function findTrackingNumbers(text: string): TrackingHit[] {
	const out = new Map<string, TrackingHit>();
	for (const pattern of TRACKING_PATTERNS) {
		for (const m of text.matchAll(pattern.re)) {
			if (pattern.near) {
				const i = m.index ?? 0;
				const around = text.slice(Math.max(0, i - 80), i + m[0].length + 20);
				if (!pattern.near.test(around)) continue;
			}
			if (!out.has(m[0]))
				out.set(m[0], { carrier: pattern.carrier, trackingNumber: m[0] });
		}
	}
	return [...out.values()];
}

/** Guesses a carrier from free text ("Shipped with UPS"). */
/**
 * Carrier implied by an unambiguous tracking-number format (UPS 1Z…, USPS
 * 20/22-digit IMpb and S10 "…US", Amazon TBA…). Formats shared by several
 * carriers (FedEx/DHL digit strings) are left to `detectCarrier`.
 */
export function carrierForTrackingNumber(
	trackingNumber: string | undefined,
): string | undefined {
	const n = trackingNumber?.replace(/\s+/g, "").toUpperCase();
	if (!n) return undefined;
	if (/^1Z[0-9A-Z]{16}$/.test(n)) return "UPS";
	if (/^9[2-5]\d{18,24}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return "USPS";
	if (/^TBA\d{12}$/.test(n)) return "Amazon Logistics";
	return undefined;
}

export function detectCarrier(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const carriers: Array<[RegExp, string]> = [
		[/\bups\b/i, "UPS"],
		[/\busps\b|postal service/i, "USPS"],
		[/fed\s?ex/i, "FedEx"],
		[/\bdhl\b/i, "DHL"],
		[/amazon logistics|\bamzl\b/i, "Amazon Logistics"],
		[/canada post|postes canada/i, "Canada Post"],
		[/royal mail/i, "Royal Mail"],
		[/\bdpd\b/i, "DPD"],
		[/\bhermes\b|\bevri\b/i, "Evri"],
		[/\bgls\b/i, "GLS"],
		[/deutsche post/i, "Deutsche Post"],
		[/cainiao/i, "Cainiao"],
		[/china post/i, "China Post"],
		[/\byanwen\b/i, "Yanwen"],
		[/\b4px\b/i, "4PX"],
		[/purolator/i, "Purolator"],
		[/ontrac/i, "OnTrac"],
	];
	for (const [re, name] of carriers) if (re.test(text)) return name;
	return undefined;
}
