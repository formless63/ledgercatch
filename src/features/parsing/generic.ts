import { dateFromText, extractOrderIdFromText } from "./heuristics";
import { type Doc, documentLinks, linesOf, loadHtml } from "./html";
import { findRecords, isRecord, unwrapBody } from "./json";
import { dataLayerOrders, ecommerceOrder } from "./platforms/datalayer";
import { platformOrders } from "./platforms/index";
import { medusaJsonOrders } from "./platforms/medusa";
import {
	jsonLdOrders,
	microdataOrders,
	orderFromSchema,
	schemaTypes,
} from "./platforms/schema-org";
import { buildResult, safeParse } from "./result";
import { normalizeStatus } from "./status";
import {
	cleanText,
	extractLast4,
	findTrackingNumbers,
	moneyAfterLabel,
} from "./text";
import type {
	ParsedOrder,
	ParseResult,
	ParserInput,
	StoreParser,
} from "./types";

export {
	jsonLdOrders,
	microdataOrders,
	orderFromSchema,
} from "./platforms/schema-org";

/* ------------------------------------------------------------------------ */
/* Visible-text heuristics                                                   */
/* ------------------------------------------------------------------------ */

const ORDER_PAGE_URL_RE =
	/(thank[-_]?you|order[-_]?(confirmation|received|complete|success|details?|status)|checkout\/(success|complete)|receipt|invoice|\/orders?\/[\w-]+)/i;
const ORDER_PAGE_TEXT_RE =
	/thank(s| you) for (your )?(order|purchase)|order (confirmation|confirmed|details|summary|received)|your order (has been|is) (placed|confirmed|received)|\binvoice\b|\breceipt\b|bestellbestätigung|bestelldetails|rechnung/i;

/**
 * Text heuristics on visible text. Only produces an order when it finds an
 * order id AND a total AND the page is plausibly an order page; otherwise the
 * AI fallback is a better bet.
 */
export function textHeuristicOrder(
	lines: string[],
	input: Pick<
		ParserInput,
		"pageType" | "pageUrl" | "pageTitle" | "orderIdHints"
	>,
	currencyHint?: string,
): { order?: ParsedOrder; reason?: string } {
	const text = lines.join("\n");
	const flat = cleanText(text);
	const orderish =
		input.pageType !== "unknown" ||
		ORDER_PAGE_URL_RE.test(input.pageUrl) ||
		ORDER_PAGE_TEXT_RE.test(`${input.pageTitle} ${flat.slice(0, 20_000)}`);
	if (!orderish) return { reason: "page does not look like an order page" };
	const id =
		extractOrderIdFromText(flat) ??
		(input.orderIdHints.length === 1 ? input.orderIdHints[0] : undefined);
	if (!id) return { reason: "no order number found in text" };
	const total =
		moneyAfterLabel(
			text,
			/\b(?:grand\s+total|order\s+total|total\s+(?:paid|charged|due|amount|for this order)|amount\s+(?:paid|charged)|gesamtsumme|gesamtbetrag)\b\s*:?/i,
			{
				currency: currencyHint,
				last: true,
			},
		) ??
		moneyAfterLabel(
			text,
			/(?<!sub\s?-?)\btotal\b(?!\s*before)\s*(?:\([^)]{0,30}\))?\s*:?/i,
			{
				currency: currencyHint,
				last: true,
			},
		);
	if (!total) return { reason: "no order total found in text" };
	const currency = total.currency ?? currencyHint;
	const opts = { currency };
	const last4 = extractLast4(flat);
	const tracking = findTrackingNumbers(flat);
	return {
		order: {
			externalOrderId: id,
			orderDate: dateFromText(flat),
			currency,
			totalMinor: total.amountMinor,
			subtotalMinor: moneyAfterLabel(
				text,
				/\b(?:sub\s*-?total|items?\s+subtotal|merchandise(?:\s+total)?|zwischensumme)\b(?:\s*\(\d+[^)]*\))?\s*:?/i,
				opts,
			)?.amountMinor,
			shippingMinor: moneyAfterLabel(
				text,
				/\b(?:shipping|delivery|postage|freight|versand(?:kosten)?)(?:\s*(?:&|and)\s*handling)?\b\s*:?/i,
				{ ...opts, allowFree: true },
			)?.amountMinor,
			taxMinor: moneyAfterLabel(
				text,
				/\b(?:estimated\s+tax|sales\s+tax|tax|vat|gst|hst|pst|qst|mwst|ust)\b[^:\n$€£]{0,30}:?/i,
				opts,
			)?.amountMinor,
			discountMinor: moneyAfterLabel(
				text,
				/\b(?:discount|promotion|coupon|savings|promo(?:\s+code)?|rabatt|gutschein)\b[^:\n$€£]{0,30}:?/i,
				opts,
			)?.amountMinor,
			paymentLast4: last4,
			status: normalizeStatus(
				/\b(?:status|order status)\s*:?\s*([A-Za-z][A-Za-z ]{2,30})/i.exec(
					flat,
				)?.[1],
			),
			shipments: tracking.map((t) => ({
				trackingNumber: t.trackingNumber,
				carrier: t.carrier,
			})),
		},
	};
}

/* ------------------------------------------------------------------------ */
/* Parser                                                                    */
/* ------------------------------------------------------------------------ */

function merchantFromPage($: Doc, pageUrl: string): string | undefined {
	const og =
		$('meta[property="og:site_name"]').attr("content") ??
		$('meta[name="application-name"]').attr("content") ??
		$('meta[name="og:site_name"]').attr("content");
	if (og && cleanText(og)) return cleanText(og);
	try {
		return new URL(pageUrl).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

/**
 * Structured + heuristic extraction from any HTML page. Exported so store
 * parsers can use it as a fallback for layouts they do not recognize.
 *
 * Chain: storefront platform parsers (Shopify, WooCommerce, PrestaShop,
 * Magento, BigCommerce, Medusa) → schema.org JSON-LD / microdata → analytics
 * data layers → visible-text heuristics. When a platform parser recognises
 * the page, other structured sources only contribute to orders with the same
 * number (a tracking script's id is never trusted over the page's own).
 */
export function genericHtmlOrders(
	$: Doc,
	input: ParserInput,
	options: {
		currencyHint?: string;
		allowText?: boolean;
		/** Raw HTML when the caller has it (saves re-serializing the DOM). */
		html?: string;
		/** Run storefront platform parsers (default true). */
		platforms?: boolean;
	} = {},
): {
	orders: ParsedOrder[];
	warnings: string[];
	reason: string;
	platform?: string;
} {
	const base = input.pageUrl;
	const warnings: string[] = [];
	const platform =
		(options.platforms ?? input.source === "generic") === false
			? undefined
			: platformOrders({
					$,
					html: options.html ?? $.html(),
					url: base,
					input,
					currencyHint: options.currencyHint,
				});
	const otherStructured = [
		...jsonLdOrders($, base),
		...microdataOrders($, base),
		...dataLayerOrders($, base),
	];
	let structured: ParsedOrder[];
	if (platform) {
		const ids = new Set(platform.orders.map((o) => o.externalOrderId));
		structured = [
			...platform.orders,
			...otherStructured.filter((o) => ids.has(o.externalOrderId)),
		];
	} else structured = otherStructured;
	const merchant = merchantFromPage($, base);
	const links = documentLinks($, base);
	if (structured.length > 0) {
		const single = new Set(structured.map((o) => o.externalOrderId)).size === 1;
		return {
			orders: structured.map((o) => ({
				...o,
				merchantName: o.merchantName ?? merchant,
				documentLinks: [...(o.documentLinks ?? []), ...(single ? links : [])],
			})),
			warnings,
			reason: "",
			platform: platform?.platform,
		};
	}
	if (options.allowText === false)
		return { orders: [], warnings, reason: "no structured order data" };
	const body = $("body").length ? $("body") : $.root();
	const lines = linesOf(body);
	const { order, reason } = textHeuristicOrder(
		lines,
		input,
		options.currencyHint,
	);
	if (!order) return { orders: [], warnings, reason: reason ?? "no orders" };
	warnings.push("generic: extracted from visible text heuristics");
	return {
		orders: [
			{
				...order,
				merchantName: merchant,
				orderUrl: input.pageUrl,
				documentLinks: links,
			},
		],
		warnings,
		reason: "",
	};
}

function parseGenericJson(body: unknown, input: ParserInput): ParseResult {
	const data = unwrapBody(body);
	const base = input.pageUrl;
	const orders: ParsedOrder[] = [...medusaJsonOrders(data, base)];
	if (orders.length === 0)
		for (const node of findRecords(data, (r) =>
			schemaTypes(r).some((t) => t === "Order" || t === "Invoice"),
		)) {
			const order = orderFromSchema(node, base);
			if (order) orders.push(order);
		}
	if (orders.length === 0)
		for (const obj of findRecords(
			data,
			(r) => "transaction_id" in r || isRecord(r.actionField),
		)) {
			const order = ecommerceOrder(obj, base);
			if (order) orders.push(order);
		}
	return buildResult(
		orders,
		[],
		"no Medusa order, schema.org Order or purchase event in JSON",
	);
}

export const genericParser: StoreParser = {
	source: "generic",
	version: 2,
	parse(input) {
		return safeParse("generic", () => {
			const { payload } = input;
			if (payload.type === "json") return parseGenericJson(payload.body, input);
			if (payload.type === "text") {
				const lines = payload.text.split(/\n+/).map(cleanText).filter(Boolean);
				const { order, reason } = textHeuristicOrder(lines, input);
				// Plain text is better served by AI extraction; only claim it when sure.
				if (!order || !order.orderDate)
					return {
						outcome: "no_orders",
						reason: reason ?? "text needs AI extraction",
					};
				return buildResult(
					[order],
					["generic: extracted from page text heuristics"],
					"no orders",
				);
			}
			const $ = loadHtml(payload.html);
			const { orders, warnings, reason } = genericHtmlOrders($, input, {
				html: payload.html,
			});
			return buildResult(orders, warnings, reason || "no confident order data");
		});
	},
};
