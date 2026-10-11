/**
 * Store-specific confirmation / shipping email parsers. Each returns order
 * fragments keyed by the same externalOrderId the browser-extension parsers
 * use, so email captures merge with page captures of the same order:
 *
 *   amazon      112-1234567-1234567 (or D01-… digital)
 *   aliexpress  16-digit order id
 *   alibaba     Trade Assurance order id (12–20 digits)
 *   ebay        12-34567-89012
 *   digikey     Sales Order # (7–10 digits)
 *   mouser      Web Order # (falls back to Sales Order #)
 *
 * Emails rarely show everything (shipping notices only carry an id and a
 * tracking number) — fragments omit what they cannot see.
 */
import { dateFromText } from "../heuristics";
import { tableItems } from "../tables";
import { cleanText } from "../text";
import type { ParsedItem, ParsedOrder } from "../types";
import {
	allMatches,
	type EmailContext,
	firstMatch,
	itemsFromQuantityLines,
	paymentFrom,
	shipmentsFrom,
	statusForKind,
	totalsFrom,
} from "./common";

export type EmailStoreParse = {
	orders: ParsedOrder[];
	warnings: string[];
	reason?: string;
};

export type EmailStoreParser = {
	id: string;
	version: number;
	parse(ctx: EmailContext): EmailStoreParse;
};

/** Order date: labeled date in a confirmation, else the email's date. */
function confirmationDate(ctx: EmailContext): string | undefined {
	if (ctx.kind !== "confirmation") return undefined;
	return dateFromText(ctx.flat) ?? ctx.emailDate;
}

function shipmentPart(ctx: EmailContext): Partial<ParsedOrder> {
	const shipments = shipmentsFrom(ctx);
	return shipments.length ? { shipments } : {};
}

/** Totals/items only make sense when the email is about a single order. */
function single(ctx: EmailContext, ids: string[]): boolean {
	return ids.length === 1 && ctx.kind !== "other";
}

function labeledValue(ctx: EmailContext, label: RegExp): string | undefined {
	const m = label.exec(ctx.text);
	return m?.[1] ? cleanText(m[1]) : undefined;
}

/* ------------------------------------------------------------------------ */

const AMAZON_ID = /\b((?:\d{3}|D\d{2})-\d{7}-\d{7})\b/;

export const amazonEmail: EmailStoreParser = {
	id: "amazon-email",
	version: 1,
	parse(ctx) {
		const ids = allMatches(ctx, AMAZON_ID);
		if (ids.length === 0)
			return { orders: [], warnings: [], reason: "no Amazon order number" };
		const domain =
			/amazon\.[a-z.]+$/.exec(ctx.senderDomain)?.[0] ?? "amazon.com";
		const origin = `https://www.${domain}`;
		const status = statusForKind(ctx.kind);
		const base = (id: string): ParsedOrder => ({
			externalOrderId: id,
			merchantName: "Amazon",
			orderUrl: `${origin}/gp/your-account/order-details?orderID=${id}`,
			status,
			statusText: ctx.kind === "other" ? undefined : ctx.subject,
		});
		if (!single(ctx, ids)) return { orders: ids.map(base), warnings: [] };
		const id = ids[0] as string;
		const totals: Partial<ReturnType<typeof totalsFrom>> =
			ctx.kind === "confirmation" ? totalsFrom(ctx) : {};
		const items =
			ctx.kind === "confirmation"
				? itemsFromQuantityLines(ctx.lines, {
						currency: totals.currency,
						stopAt:
							/^(?:item\(?s\)? subtotal|order (?:summary|total)|grand total)/i,
					})
				: [];
		return {
			orders: [
				{
					...base(id),
					orderDate:
						ctx.kind === "confirmation"
							? (dateFromText(ctx.flat) ?? ctx.emailDate)
							: undefined,
					...totals,
					...paymentFrom(ctx),
					items: items.length ? items : undefined,
					// Confirmation emails list what was ordered, but Amazon
					// truncates long orders ("and 3 more items").
					itemsPartial: /\band \d+ more items?\b/i.test(ctx.flat) || undefined,
					...shipmentPart(ctx),
				},
			],
			warnings: [],
		};
	},
};

/* ------------------------------------------------------------------------ */

const ALIEXPRESS_ID =
	/\border\s*(?:id|no\.?|number|#)?\s*[:#]?\s*(\d{15,17})\b/i;

export const aliexpressEmail: EmailStoreParser = {
	id: "aliexpress-email",
	version: 1,
	parse(ctx) {
		const ids = allMatches(ctx, ALIEXPRESS_ID);
		if (ids.length === 0)
			return { orders: [], warnings: [], reason: "no AliExpress order id" };
		const status = statusForKind(ctx.kind);
		const base = (id: string): ParsedOrder => ({
			externalOrderId: id,
			orderUrl: `https://www.aliexpress.com/p/order/detail.html?orderId=${id}`,
			status,
			statusText: ctx.kind === "other" ? undefined : ctx.subject,
		});
		if (!single(ctx, ids)) return { orders: ids.map(base), warnings: [] };
		const totals = totalsFrom(ctx, "USD");
		const items = itemsFromQuantityLines(ctx.lines, {
			currency: totals.currency,
		});
		const store = labeledValue(
			ctx,
			/\b(?:store|sold by|seller)\s*:\s*([^\n]{2,80})/i,
		);
		return {
			orders: [
				{
					...base(ids[0] as string),
					merchantName: store,
					orderDate: confirmationDate(ctx),
					...(totals.totalMinor !== undefined ? totals : {}),
					items: items.length ? items : undefined,
					// Shipping notices list only what shipped.
					itemsPartial: ctx.kind !== "confirmation" || undefined,
					...shipmentPart(ctx),
				},
			],
			warnings: [],
		};
	},
};

/* ------------------------------------------------------------------------ */

const ALIBABA_ID =
	/\b(?:trade assurance\s+)?order\s*(?:id|no\.?|number|#)?\s*[:#]?\s*(\d{12,20})\b/i;

export const alibabaEmail: EmailStoreParser = {
	id: "alibaba-email",
	version: 1,
	parse(ctx) {
		const ids = allMatches(ctx, ALIBABA_ID);
		if (ids.length === 0)
			return { orders: [], warnings: [], reason: "no Alibaba order id" };
		const status = statusForKind(ctx.kind);
		const base = (id: string): ParsedOrder => ({
			externalOrderId: id,
			orderUrl: `https://biz.alibaba.com/ta/detail.htm?orderId=${id}`,
			status,
			statusText: ctx.kind === "other" ? undefined : ctx.subject,
		});
		if (!single(ctx, ids)) return { orders: ids.map(base), warnings: [] };
		const totals = totalsFrom(ctx, "USD");
		let items: ParsedItem[] = ctx.$
			? tableItems(
					ctx.$,
					undefined,
					"https://www.alibaba.com/",
					totals.currency,
				)
			: [];
		if (items.length === 0)
			items = itemsFromQuantityLines(ctx.lines, { currency: totals.currency });
		const supplier = labeledValue(
			ctx,
			/\b(?:supplier|seller|sold by)\s*:\s*([^\n]{2,120})/i,
		);
		return {
			orders: [
				{
					...base(ids[0] as string),
					merchantName: supplier,
					orderDate: confirmationDate(ctx),
					...(totals.totalMinor !== undefined ? totals : {}),
					items: items.length ? items : undefined,
					// Shipping notices list only what shipped.
					itemsPartial: ctx.kind !== "confirmation" || undefined,
					...shipmentPart(ctx),
				},
			],
			warnings: [],
		};
	},
};

/* ------------------------------------------------------------------------ */

const EBAY_ID = /\b(\d{2}-\d{5}-\d{5})\b/;

export const ebayEmail: EmailStoreParser = {
	id: "ebay-email",
	version: 1,
	parse(ctx) {
		const ids = allMatches(ctx, EBAY_ID);
		if (ids.length === 0)
			return {
				orders: [],
				warnings: [],
				reason: "no eBay order number (12-34567-89012)",
			};
		const status = statusForKind(ctx.kind);
		const base = (id: string): ParsedOrder => ({
			externalOrderId: id,
			orderUrl: `https://order.ebay.com/ord/show?orderId=${id}#/`,
			status,
			statusText: ctx.kind === "other" ? undefined : ctx.subject,
		});
		if (!single(ctx, ids)) return { orders: ids.map(base), warnings: [] };
		const totals = totalsFrom(ctx);
		const items = itemsFromQuantityLines(ctx.lines, {
			currency: totals.currency,
			stopAt: /^(?:order total|subtotal|total charged|payment)/i,
		});
		const itemId = /\bitem\s*(?:id|number|#)\s*:?\s*(\d{9,14})\b/i.exec(
			ctx.flat,
		)?.[1];
		if (itemId && items.length === 1 && items[0])
			items[0] = { ...items[0], externalItemId: itemId };
		const seller = labeledValue(
			ctx,
			/\b(?:seller|sold by)\s*:?\s*\n?([A-Za-z0-9._-]{3,64})\b/i,
		);
		return {
			orders: [
				{
					...base(ids[0] as string),
					merchantName: seller,
					orderDate: confirmationDate(ctx),
					...(totals.totalMinor !== undefined ? totals : {}),
					...paymentFrom(ctx),
					items: items.length ? items : undefined,
					// Shipping notices list only what shipped.
					itemsPartial: ctx.kind !== "confirmation" || undefined,
					...shipmentPart(ctx),
				},
			],
			warnings: [],
		};
	},
};

/* ------------------------------------------------------------------------ */

const DIGIKEY_ID = [
	/\bsales\s*order\s*(?:#|no\.?|number)?\s*:?\s*#?\s*(\d{7,10})\b/i,
	/\bsalesorder\s*:?\s*#?\s*(\d{7,10})\b/i,
	/\border\s*(?:#|no\.?|number)\s*:?\s*#?\s*(\d{7,10})\b/i,
];

export const digikeyEmail: EmailStoreParser = {
	id: "digikey-email",
	version: 1,
	parse(ctx) {
		const id = firstMatch(ctx, DIGIKEY_ID);
		if (!id)
			return { orders: [], warnings: [], reason: "no DigiKey sales order #" };
		const totals = totalsFrom(ctx, "USD");
		const items = ctx.$
			? tableItems(
					ctx.$,
					undefined,
					"https://www.digikey.com/",
					totals.currency,
				)
			: [];
		const invoice =
			/\binvoice\s*(?:#|no\.?|number)?\s*:?\s*#?\s*(\d{6,10})\b/i.exec(
				ctx.flat,
			)?.[1];
		return {
			orders: [
				{
					externalOrderId: id,
					merchantName: "DigiKey",
					orderUrl: `https://www.digikey.com/OrderHistory/ReviewOrder/${id}`,
					status: statusForKind(ctx.kind),
					statusText:
						ctx.kind === "other"
							? undefined
							: invoice && !ctx.subject.includes(invoice)
								? `${ctx.subject} (invoice ${invoice})`
								: ctx.subject,
					orderDate: confirmationDate(ctx),
					...(totals.totalMinor !== undefined ? totals : {}),
					items: items.length ? items : undefined,
					// Shipping notices list only what shipped.
					itemsPartial: ctx.kind !== "confirmation" || undefined,
					...shipmentPart(ctx),
				},
			],
			warnings: [],
		};
	},
};

/* ------------------------------------------------------------------------ */

const MOUSER_WEB =
	/\bweb\s*order\s*(?:#|no\.?|number)?\s*:?\s*#?\s*(\d{6,12})\b/i;
const MOUSER_SALES =
	/\bsales\s*order\s*(?:#|no\.?|number)?\s*:?\s*#?\s*(\d{6,12})\b/i;

export const mouserEmail: EmailStoreParser = {
	id: "mouser-email",
	version: 1,
	parse(ctx) {
		const web = firstMatch(ctx, [MOUSER_WEB]);
		const sales = firstMatch(ctx, [MOUSER_SALES]);
		const id = web ?? sales;
		if (!id)
			return {
				orders: [],
				warnings: [],
				reason: "no Mouser web order # / sales order #",
			};
		const totals = totalsFrom(ctx, "USD");
		const items = ctx.$
			? tableItems(ctx.$, undefined, "https://www.mouser.com/", totals.currency)
			: [];
		return {
			orders: [
				{
					externalOrderId: id,
					merchantName: "Mouser Electronics",
					orderUrl: "https://www.mouser.com/OrderHistory/OrdersView.aspx",
					status: statusForKind(ctx.kind),
					statusText:
						ctx.kind === "other"
							? undefined
							: web && sales
								? `${ctx.subject} (sales order ${sales})`
								: ctx.subject,
					orderDate: confirmationDate(ctx),
					...(totals.totalMinor !== undefined ? totals : {}),
					...paymentFrom(ctx),
					items: items.length ? items : undefined,
					// Shipping notices list only what shipped.
					itemsPartial: ctx.kind !== "confirmation" || undefined,
					...shipmentPart(ctx),
				},
			],
			warnings: web
				? []
				: ["mouser-email: keyed by Sales Order # (no Web Order # in email)"],
		};
	},
};

export const EMAIL_STORE_PARSERS: Partial<Record<string, EmailStoreParser>> = {
	amazon: amazonEmail,
	aliexpress: aliexpressEmail,
	alibaba: alibabaEmail,
	ebay: ebayEmail,
	digikey: digikeyEmail,
	mouser: mouserEmail,
};
