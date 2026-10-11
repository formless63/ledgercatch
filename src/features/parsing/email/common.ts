/** Shared helpers for store email parsers (pure, deterministic). */
import { parseDate } from "../dates";
import { type Doc, linesOf, loadHtml } from "../html";
import { findMoneyStrings, parseMoney } from "../money";
import {
	cleanText,
	detectCarrier,
	findTrackingNumbers,
	moneyAfterLabel,
} from "../text";
import type { OrderStatus, ParsedItem, ParsedShipment } from "../types";
import { emailDomain } from "./detect";
import type { EmailMessage } from "./types";

export type EmailKind =
	| "confirmation"
	| "shipped"
	| "delivered"
	| "cancelled"
	| "returned"
	| "other";

export type EmailContext = {
	email: EmailMessage;
	/** Parsed HTML body when the email has one. */
	$?: Doc;
	/** Visible lines (HTML block-aware, or the plain-text body). */
	lines: string[];
	/** `lines` joined with "\n" (for label → money lookups). */
	text: string;
	/** Single-line whitespace-collapsed text. */
	flat: string;
	subject: string;
	kind: EmailKind;
	/** YYYY-MM-DD of the (original) message. */
	emailDate?: string;
	senderDomain: string;
};

function textLines(text: string): string[] {
	return text.split(/\r?\n/).map(cleanText).filter(Boolean);
}

/** "Fwd: Re: Your order" → "Your order". */
export function stripSubjectPrefixes(subject: string): string {
	return cleanText(
		subject.replace(
			/^(?:\s*(?:fwd?|fw|re|aw|wg|tr|rv)\s*(?:\[\d+\])?:\s*)+/i,
			"",
		),
	);
}

export function emailKind(subject: string, flat: string): EmailKind {
	const s = subject;
	if (/\bdelivered\b|\bzugestellt\b|\blivré/i.test(s)) return "delivered";
	if (/\bcancel+(?:ed|ation)\b|\bstorniert\b|\bannul/i.test(s))
		return "cancelled";
	if (
		/\brefund|\breturn (?:received|started|request|label)|\berstattung/i.test(s)
	)
		return "returned";
	if (
		/\bshipped\b|\bshipping (?:confirmation|notification|update)\b|on (?:its|the) way|\bdispatched\b|\bshipment\b|out for delivery|\bversandt?\b|\bin transit\b|\bhas shipped\b/i.test(
			s,
		)
	)
		return "shipped";
	if (
		/\border\b|\bconfirm|\breceipt\b|\bthank|\bpurchase|\bpayment\b|\backnowledg|\bbestell|\binvoice\b/i.test(
			s,
		)
	)
		return "confirmation";
	const head = flat.slice(0, 4000);
	if (/\bhas (?:been )?shipped\b|\bon its way\b/i.test(head)) return "shipped";
	if (/thank(?:s| you) for (?:your )?(?:order|purchase)/i.test(head))
		return "confirmation";
	return "other";
}

export function statusForKind(kind: EmailKind): OrderStatus | undefined {
	switch (kind) {
		case "confirmation":
			return "placed";
		case "shipped":
			return "shipped";
		case "delivered":
			return "delivered";
		case "cancelled":
			return "cancelled";
		case "returned":
			return "returned";
		default:
			return undefined;
	}
}

export function buildEmailContext(email: EmailMessage): EmailContext {
	let $: Doc | undefined;
	let lines: string[] = [];
	if (email.html?.trim()) {
		$ = loadHtml(email.html);
		const body = $("body").length ? $("body") : $.root();
		lines = linesOf(body);
	}
	if (lines.length === 0 && email.text) lines = textLines(email.text);
	const text = lines.join("\n");
	const flat = cleanText(text);
	const subject = stripSubjectPrefixes(email.subject ?? "");
	return {
		email,
		$,
		lines,
		text,
		flat,
		subject,
		kind: emailKind(subject, flat),
		emailDate: email.date ? parseDate(email.date.slice(0, 10)) : undefined,
		senderDomain: emailDomain(email.from?.address),
	};
}

/** Money after the last matching label (totals appear after line items). */
export function labeledMoney(
	ctx: EmailContext,
	label: RegExp,
	options: { currency?: string; last?: boolean; allowFree?: boolean } = {},
) {
	return moneyAfterLabel(ctx.text, label, { window: 60, ...options });
}

export const TOTAL_LABEL =
	/\b(?:grand\s+total|order\s+total|total\s+(?:paid|charged|amount|due|price)|amount\s+(?:paid|charged)|payment\s+total|order\s+amount|total)\b(?:\s*\([^)]{0,30}\))?\s*:?/i;
export const SUBTOTAL_LABEL =
	/\b(?:sub\s*-?total|item\(?s\)?\s+subtotal|items?\s+total|merchandise(?:\s+total)?|product\s+total)\b(?:\s*\(\d+[^)]*\))?\s*:?/i;
export const SHIPPING_LABEL =
	/\b(?:shipping(?:\s*(?:&|and|\/)\s*handling|\s+(?:fee|cost|charges?))?|delivery\s+(?:fee|charge|cost)s?|postage|freight)\b\s*(?:\([^)]{0,40}\))?\s*:?/i;
export const TAX_LABEL =
	/(?<!before\s)\b(?:estimated\s+tax(?:\s+to\s+be\s+collected)?|sales\s+tax|tax(?:es)?|vat|gst|hst)\b[^:\n$€£]{0,20}:?/i;
export const DISCOUNT_LABEL =
	/\b(?:discount|promotion(?:\s+applied)?|coupon|savings|promo(?:\s+code)?|store\s+discount)\b[^:\n$€£]{0,20}:?/i;

/**
 * Order totals block. The "Total" lookup ignores subtotals (moneyAfterLabel
 * would otherwise match "Subtotal" via the bare `total` alternative).
 */
export function totalsFrom(ctx: EmailContext, currency?: string) {
	const text = ctx.text;
	const opts = { currency, window: 40 };
	const total = moneyAfterLabel(
		text
			.replace(/sub\s*-?total/gi, "subxxxxx")
			.replace(/total\s+before/gi, "xxxxx before"),
		TOTAL_LABEL,
		{ ...opts, last: true },
	);
	const cur = total?.currency ?? currency;
	const subtotal = moneyAfterLabel(text, SUBTOTAL_LABEL, {
		...opts,
		currency: cur,
	});
	const shipping = moneyAfterLabel(text, SHIPPING_LABEL, {
		...opts,
		currency: cur,
		allowFree: true,
	});
	const tax = moneyAfterLabel(text, TAX_LABEL, { ...opts, currency: cur });
	const discount = moneyAfterLabel(text, DISCOUNT_LABEL, {
		...opts,
		currency: cur,
	});
	return {
		currency: cur,
		totalMinor: total?.amountMinor,
		subtotalMinor: subtotal?.amountMinor,
		shippingMinor: shipping?.amountMinor,
		taxMinor: tax?.amountMinor,
		discountMinor: discount ? Math.abs(discount.amountMinor) : undefined,
	};
}

/** Tracking numbers with a carrier guess from the surrounding text. */
export function shipmentsFrom(ctx: EmailContext): ParsedShipment[] {
	const carrierHint = detectCarrier(ctx.flat);
	const out: ParsedShipment[] = [];
	const seen = new Set<string>();
	// Labeled numbers first ("Tracking number: XYZ"), which catch formats the
	// generic patterns miss (Yanwen, 4PX, Cainiao …).
	for (const m of ctx.flat.matchAll(
		/\btracking\s*(?:number|no\.?|#|id)?\s*[:#]?\s*([A-Z0-9]{8,34})\b/gi,
	)) {
		const value = m[1] ?? "";
		if (!/\d/.test(value) || seen.has(value)) continue;
		seen.add(value);
		out.push({ trackingNumber: value, carrier: carrierHint });
	}
	for (const hit of findTrackingNumbers(ctx.flat)) {
		if (seen.has(hit.trackingNumber)) continue;
		seen.add(hit.trackingNumber);
		out.push({
			trackingNumber: hit.trackingNumber,
			carrier: hit.carrier ?? carrierHint,
		});
	}
	return out;
}

const QTY_LINE = /^(?:qty|quantity|menge|anzahl)\s*[:x×]?\s*(\d{1,5})\b/i;
const QTY_INLINE =
	/\b(?:qty|quantity)\s*[:x×]?\s*(\d{1,5})\b|^\s*(\d{1,4})\s*[x×]\s+/i;
const NOISE_LINE =
	/^(?:qty|quantity|price|sold by|seller|condition|item id|order|total|subtotal|shipping|tax|arriving|delivered|ship to|view|track|buy again|write a review|return|\$|€|£|\d)/i;

const TOTALS_LINE =
	/\b(?:sub\s*-?total|total|shipping|tax|discount|savings|refund)\b/i;

function moneyIn(line: string, currency?: string) {
	const s = findMoneyStrings(line)[0];
	return s ? parseMoney(s, { currency }) : undefined;
}

/**
 * Items laid out as stacked lines: title, then "Quantity: N", then a price
 * (Amazon, eBay, AliExpress, Shopify emails). The title is the nearest
 * preceding line that is not a label/price.
 */
export function itemsFromQuantityLines(
	lines: string[],
	options: { currency?: string; stopAt?: RegExp } = {},
): ParsedItem[] {
	const items: ParsedItem[] = [];
	const stop = options.stopAt
		? lines.findIndex((l) => options.stopAt?.test(l))
		: -1;
	const limit = stop >= 0 ? stop : lines.length;
	let lastTitleIndex = -1;
	for (let i = 0; i < limit; i++) {
		const line = lines[i] ?? "";
		const m = QTY_LINE.exec(line) ?? null;
		if (!m) continue;
		const quantity = Number(m[1]);
		let title: string | undefined;
		for (let j = i - 1; j > lastTitleIndex && j >= i - 4; j--) {
			const candidate = lines[j] ?? "";
			if (NOISE_LINE.test(candidate) || candidate.length < 4) continue;
			if (findMoneyStrings(candidate).length && candidate.length < 24) continue;
			title = candidate;
			lastTitleIndex = j;
			break;
		}
		if (!title) continue;
		// Price: same line, then neighbours (never a totals line).
		const priceLine = (k: number) => {
			const candidate = lines[k] ?? "";
			if (k === lastTitleIndex || TOTALS_LINE.test(candidate)) return undefined;
			return moneyIn(candidate, options.currency);
		};
		const price =
			moneyIn(line.slice(m[0].length), options.currency) ??
			priceLine(i + 1) ??
			priceLine(i - 1) ??
			priceLine(i + 2);
		const variant = lines
			.slice(lastTitleIndex + 1, i)
			.filter((l) => /^(?:color|colour|size|style|variant|model)\s*:/i.test(l))
			.join(", ");
		items.push({
			title,
			quantity,
			variant: variant || undefined,
			// Store emails show the line price (unit × qty) next to quantity.
			totalMinor: price?.amountMinor,
			unitPriceMinor:
				price && quantity > 0
					? Math.round(price.amountMinor / quantity)
					: undefined,
		});
	}
	return items;
}

/** Same as QTY_INLINE test, exported for parsers with "2 x Title" rows. */
export function inlineQuantity(line: string): number | undefined {
	const m = QTY_INLINE.exec(line);
	const value = Number(m?.[1] ?? m?.[2]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** First capture group of the first regex that matches subject, then body. */
export function firstMatch(
	ctx: EmailContext,
	patterns: RegExp[],
	where: "subject" | "body" | "both" = "both",
): string | undefined {
	const haystacks =
		where === "subject"
			? [ctx.subject]
			: where === "body"
				? [ctx.flat]
				: [ctx.subject, ctx.flat];
	for (const hay of haystacks)
		for (const re of patterns) {
			const m = re.exec(hay);
			if (m?.[1]) return m[1];
		}
	return undefined;
}

/** All distinct first-group matches of a global regex in subject + body. */
export function allMatches(ctx: EmailContext, re: RegExp): string[] {
	const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
	const g = new RegExp(re.source, flags);
	const out = new Set<string>();
	for (const hay of [ctx.subject, ctx.flat])
		for (const m of hay.matchAll(g)) if (m[1]) out.add(m[1]);
	return [...out];
}

/** Payment hint + last-4 ("Visa ending in 4821"). */
export function paymentFrom(ctx: EmailContext) {
	const m =
		/\b((?:visa|mastercard|master card|amex|american express|discover|jcb|diners|maestro|paypal|apple pay|google pay|card)[^\n]{0,30}?(?:ending|ends)\s+(?:in|with)\s*:?\s*(\d{4}))/i.exec(
			ctx.text,
		);
	if (m) return { paymentHint: cleanText(m[1]), paymentLast4: m[2] };
	const any = /(?:ending|ends)\s+(?:in|with)\s*:?\s*(\d{4})\b/i.exec(ctx.text);
	return { paymentLast4: any?.[1] };
}
