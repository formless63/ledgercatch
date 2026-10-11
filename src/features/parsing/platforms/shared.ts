/** Small helpers shared by the platform parsers. Pure; never throw. */
import type { Doc, Sel } from "../html";
import { textOf } from "../html";
import { normalizeCurrencyCode, parseMoney } from "../money";
import { cleanText } from "../text";
import type { ParsedOrder } from "../types";

export type Totals = Pick<
	ParsedOrder,
	| "subtotalMinor"
	| "shippingMinor"
	| "taxMinor"
	| "discountMinor"
	| "totalMinor"
	| "currency"
>;

export type TotalKind = "subtotal" | "shipping" | "tax" | "discount" | "total";

/**
 * Classifies a totals-row label ("Subtotal:", "Shipping (Standard)",
 * "Tax (VAT 20%)", "Grand Total (Incl.Tax)", "Discount", …). Returns
 * undefined for rows that are not money totals (payment method, refunds,
 * notes, fees we cannot place).
 */
export function totalKind(label: string): TotalKind | undefined {
	const l = cleanText(label).toLowerCase();
	if (!l) return undefined;
	if (
		/refund|payment|method|note|actions?:?$|paid by|store credit|gift card/.test(
			l,
		)
	)
		return undefined;
	if (
		/sub-?\s?total|zwischensumme|sous-total|subtotale|^products?\b|^items?\b|^total products/.test(
			l,
		)
	)
		return "subtotal";
	if (
		/^(grand\s+)?total\b|^order total|^gesamt|^montant total|^totale\b/.test(l)
	)
		return "total";
	if (
		/discount|coupon|voucher|promo|rabatt|gutschein|réduction|remise|descuento|sconto|savings/.test(
			l,
		)
	)
		return "discount";
	if (
		/shipping|delivery|postage|freight|carriage|versand|livraison|envío|envio|spedizione|porto|handling/.test(
			l,
		)
	)
		return "shipping";
	if (/\b(tax|taxes|vat|gst|hst|pst|qst|mwst|ust|tva|iva|btw|moms)\b/.test(l))
		return "tax";
	if (/\btotal\b/.test(l)) return "total";
	return undefined;
}

/**
 * Folds labeled totals rows into order totals. Multiple tax (or shipping)
 * rows are summed; of several "total" rows the tax-inclusive one wins
 * ("Total (tax incl.)", "Grand Total (Incl.Tax)"), else the last one that is
 * not explicitly tax-exclusive.
 */
export function foldTotals(
	rows: Array<{ label: string; value: string; kind?: TotalKind }>,
	currencyHint: string | undefined,
): Totals {
	const out: Totals = {};
	const totals: Array<{ label: string; minor: number }> = [];
	let currency = normalizeCurrencyCode(currencyHint);
	for (const row of rows) {
		const kind = row.kind ?? totalKind(row.label);
		if (!kind) continue;
		const money = parseMoney(row.value, {
			currency,
			allowFree: kind === "shipping",
		});
		if (!money) continue;
		if (!currency && money.currency) currency = money.currency;
		const minor = money.amountMinor;
		switch (kind) {
			case "subtotal":
				out.subtotalMinor ??= minor;
				break;
			case "shipping":
				out.shippingMinor = (out.shippingMinor ?? 0) + minor;
				break;
			case "tax":
				out.taxMinor = (out.taxMinor ?? 0) + minor;
				break;
			case "discount":
				out.discountMinor = (out.discountMinor ?? 0) + Math.abs(minor);
				break;
			case "total":
				totals.push({ label: row.label, minor });
				break;
		}
	}
	const incl = totals.find((t) => /incl/i.test(t.label));
	const notExcl = totals.filter((t) => !/excl/i.test(t.label));
	const chosen =
		incl ?? notExcl[notExcl.length - 1] ?? totals[totals.length - 1];
	if (chosen) out.totalMinor = chosen.minor;
	if (currency) out.currency = currency;
	return out;
}

/** Label/value pairs of table rows: first header-ish cell + last cell. */
export function rowPairs(
	$: Doc,
	rows: Sel,
): Array<{ label: string; value: string; className: string }> {
	const out: Array<{ label: string; value: string; className: string }> = [];
	rows.each((_, tr) => {
		const cells = $(tr).children("th,td");
		if (cells.length < 2) return;
		out.push({
			label: textOf(cells.first()),
			value: textOf(cells.last()),
			className: $(tr).attr("class") ?? "",
		});
	});
	return out;
}

/** Money in minor units from a cell's text. */
export function minorOf(
	text: string | undefined,
	currency: string | undefined,
): number | undefined {
	if (!text) return undefined;
	return parseMoney(text, { currency })?.amountMinor;
}

/** First number in text ("× 2", "2", "Qty: 3"); defaults to undefined. */
export function quantityOf(text: string | undefined): number | undefined {
	const m = /(\d+(?:[.,]\d+)?)/.exec(text ?? "");
	if (!m?.[1]) return undefined;
	const n = Number(m[1].replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** "#1001" / "No. 1001" / " 1001 " → "1001". */
export function cleanOrderNumber(text: string | undefined): string | undefined {
	const value = cleanText(text)
		.replace(/^(?:no\.?|nr\.?|n°|#)\s*/i, "")
		.replace(/^#/, "")
		.trim();
	return value && value.length <= 120 ? value : undefined;
}

/**
 * Store currency advertised by the platform's own page globals or meta tags
 * (PrestaShop `prestashop.currency.iso_code`, Shopify `Shopify.currency`,
 * WooCommerce block `wcSettings.currency.code`, Open Graph price currency).
 */
export function currencyFromHtml(html: string): string | undefined {
	const patterns = [
		/Shopify\.currency\s*=\s*\{[^}]*?["']?active["']?\s*:\s*["']([A-Za-z]{3})["']/,
		/"currency"\s*:\s*\{[^{}]*?"iso_code"\s*:\s*"([A-Za-z]{3})"/,
		/"currency"\s*:\s*\{\s*"code"\s*:\s*"([A-Za-z]{3})"/,
		/<meta[^>]+(?:property|name)=["'](?:og|product):price:currency["'][^>]*content=["']([A-Za-z]{3})["']/i,
	];
	for (const re of patterns) {
		const code = normalizeCurrencyCode(re.exec(html.slice(0, 2_000_000))?.[1]);
		if (code) return code;
	}
	return undefined;
}

/** `<html lang>` of the page, lower-cased ("en-us", "fr-fr", …). */
export function pageLang($: Doc): string {
	return ($("html").attr("lang") ?? "").toLowerCase();
}

/** True when ambiguous numeric dates on this page are day-first. */
export function dayFirstFor($: Doc): boolean {
	const lang = pageLang($);
	return lang !== "" && !/^en(-us)?$/.test(lang);
}

/** Keeps only defined fields (so `undefined` never shows up in results). */
export function defined<T extends object>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
	return out as T;
}
