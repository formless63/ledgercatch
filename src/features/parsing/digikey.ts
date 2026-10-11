/**
 * DigiKey parser.
 *
 * JSON (primary): the /OrderHistory/List SPA fetches collections whose field
 * names are known from Kagee/webshop-order-scraper (2026), exact endpoints
 * unknown, so we walk any response for:
 *   - orders / invoices: `orderNumber`, `dateEntered`, `currencyIso`,
 *     `invoices[].orderValue` (cents), `invoices[].invoiceTotalPrice`,
 *     `invoicePricing[].salesTax|freightValue` (cents)
 *   - invoiceDetails: `orderNumber` + `invoiceDetails[]` lines with
 *     `unitPrice` (÷100000), `extendedPrice` (÷100), `quantityTotal`,
 *     `description`, `manufacturerProductNumber`, `manufacturerName`, `productId`
 * PascalCase shapes from the official Order Status API (SalesOrderId,
 * LineItems[].DigiKeyPartNumber…) are accepted too.
 *
 * ShipmentTracking/TrackingInfo: trackingNumber, shipmentMethod, status and
 * currentStatus.activityDateTime enrich the order identified by the page URL.
 *
 * HTML (fallback): ReviewOrder / confirmation pages via labeled text + any
 * order table with Quantity/Part Number/Description columns.
 */
import { parseDate } from "./dates";
import { genericHtmlOrders } from "./generic";
import { dateFromText } from "./heuristics";
import { type Doc, documentLinks, linesOf, loadHtml } from "./html";
import {
	field,
	findRecords,
	isRecord,
	type JsonRecord,
	num,
	queryParam,
	records,
	str,
	unwrapBody,
} from "./json";
import { normalizeCurrencyCode, parseMoney, toMinor } from "./money";
import { buildResult, safeParse } from "./result";
import { normalizeStatus } from "./status";
import { tableItems } from "./tables";
import {
	cleanText,
	detectCarrier,
	extractLast4,
	moneyAfterLabel,
} from "./text";
import type {
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
	ParseResult,
	ParserInput,
	StoreParser,
} from "./types";

function origin(pageUrl: string): string {
	try {
		const url = new URL(pageUrl);
		return /digikey\./i.test(url.hostname)
			? url.origin
			: "https://www.digikey.com";
	} catch {
		return "https://www.digikey.com";
	}
}

function siteCurrency(pageUrl: string): string | undefined {
	try {
		const host = new URL(pageUrl).hostname;
		if (/digikey\.ca$/.test(host)) return "CAD";
		if (/digikey\.co\.uk$/.test(host)) return "GBP";
		if (
			/digikey\.(de|fr|it|es|nl|at|be|ie|fi|ee|lt|lv|sk|si|pt|gr)$/.test(host)
		)
			return "EUR";
		if (/digikey\.ch$/.test(host)) return "CHF";
		if (/digikey\.se$/.test(host)) return "SEK";
		if (/digikey\.no$/.test(host)) return "NOK";
		if (/digikey\.dk$/.test(host)) return "DKK";
		if (/digikey\.pl$/.test(host)) return "PLN";
		if (/digikey\.com\.au$/.test(host)) return "AUD";
		if (/digikey\.jp$/.test(host)) return "JPY";
		if (/digikey\.com$/.test(host)) return "USD";
	} catch {
		// ignore
	}
	return undefined;
}

const ORDER_KEYS = [
	"orderNumber",
	"salesOrderNumber",
	"salesOrderId",
	"SalesOrderId",
	"SalesOrderNumber",
];

function orderNumberOf(r: JsonRecord): string | undefined {
	const v = field(r, ...ORDER_KEYS);
	const s =
		typeof v === "number"
			? Number.isSafeInteger(v)
				? String(v)
				: `unsafe:${v}`
			: str(v);
	return s && (/^\d{6,16}$/.test(s) || s.startsWith("unsafe:")) ? s : undefined;
}

/**
 * 16-digit sales orders exceed 2^53 when sent as JSON numbers; recover the
 * exact id from hints/URL when they round to the same double, else skip.
 */
function resolveId(
	raw: string,
	input: ParserInput,
	warnings: string[],
): string | undefined {
	if (!raw.startsWith("unsafe:")) return raw;
	const value = Number(raw.slice("unsafe:".length));
	const candidates = [
		...input.orderIdHints,
		/ReviewOrder\/(\d+)/.exec(input.pageUrl)?.[1],
	].filter((c): c is string => Boolean(c && /^\d{6,16}$/.test(c)));
	const match = candidates.find((c) => Number(c) === value);
	if (!match)
		warnings.push(
			`digikey: order number ${value} exceeds 2^53 and no hint matches; skipped`,
		);
	return match;
}

/** Integer cents → minor; decimals → minor. */
function centsOrDecimal(
	value: unknown,
	currency: string | undefined,
): number | undefined {
	const n = num(value);
	if (n === undefined) {
		const parsed =
			typeof value === "string" ? parseMoney(value, { currency }) : undefined;
		return parsed?.amountMinor;
	}
	return Number.isInteger(n)
		? toMinor(n / 100, currency)
		: toMinor(n, currency);
}

function decimalAmount(
	value: unknown,
	currency: string | undefined,
): number | undefined {
	const n = num(value);
	if (n !== undefined) return toMinor(n, currency);
	return typeof value === "string"
		? parseMoney(value, { currency })?.amountMinor
		: undefined;
}

/** Infers the fixed-point scale of DigiKey's integer unit prices. */
function unitPriceMinor(
	unit: unknown,
	extendedMinor: number | undefined,
	quantity: number,
	currency: string | undefined,
): number | undefined {
	const n = num(unit);
	if (n === undefined)
		return typeof unit === "string"
			? parseMoney(unit, { currency })?.amountMinor
			: undefined;
	if (!Number.isInteger(n)) return toMinor(n, currency);
	if (extendedMinor !== undefined && quantity > 0) {
		for (const scale of [100000, 10000, 1000, 100, 1]) {
			const candidate = toMinor((n / scale) * quantity, currency);
			if (
				Math.abs(candidate - extendedMinor) <= Math.max(1, extendedMinor * 0.01)
			)
				return toMinor(n / scale, currency);
		}
	}
	return toMinor(n / 100000, currency);
}

function lineItem(
	line: JsonRecord,
	currency: string | undefined,
	site: string,
): ParsedItem {
	const quantity =
		num(
			field(
				line,
				"quantityTotal",
				"quantity",
				"Quantity",
				"quantityShipped",
				"QuantityOrdered",
			),
		) ?? 1;
	// Web-app JSON sends `extendedPrice` in integer cents; the official API
	// (PascalCase) sends decimals.
	const extendedMinor =
		line.extendedPrice !== undefined
			? centsOrDecimal(line.extendedPrice, currency)
			: decimalAmount(
					field(line, "ExtendedPrice", "TotalPrice", "totalPrice"),
					currency,
				);
	const productId = str(field(line, "productId", "ProductId"));
	const dkPart = str(
		field(
			line,
			"digiKeyProductNumber",
			"DigiKeyPartNumber",
			"digiKeyPartNumber",
		),
	);
	const mpn = str(
		field(
			line,
			"manufacturerProductNumber",
			"ManufacturerPartNumber",
			"manufacturerPartNumber",
		),
	);
	const manufacturer = str(
		field(line, "manufacturerName", "Manufacturer", "manufacturer"),
	);
	const thumb = str(
		field(line, "imageUrl", "thumbnailUrl", "PhotoUrl", "photoUrl"),
	);
	return {
		externalItemId: dkPart ?? productId,
		title:
			str(
				field(
					line,
					"description",
					"ProductDescription",
					"productDescription",
					"detailedDescription",
				),
			) ??
			mpn ??
			dkPart ??
			"",
		sku: dkPart ?? mpn ?? productId,
		variant:
			[manufacturer, mpn && dkPart ? `MPN ${mpn}` : undefined]
				.filter(Boolean)
				.join(" · ") || undefined,
		quantity,
		unitPriceMinor: unitPriceMinor(
			field(line, "unitPrice", "UnitPrice"),
			extendedMinor,
			quantity,
			currency,
		),
		totalMinor: extendedMinor,
		imageUrl: thumb
			? thumb.startsWith("//")
				? `https:${thumb}`
				: thumb
			: undefined,
		itemUrl: productId
			? `${site}/en/products/detail/-/-/${productId}`
			: undefined,
	};
}

/** ShipmentTracking has no order number: the rendered ReviewOrder URL owns it. */
function parseTracking(
	input: ParserInput,
	requestUrl: string,
	body: unknown,
): ParseResult {
	const data = unwrapBody(body);
	if (!isRecord(data) || data.success === false)
		return {
			outcome: "no_orders",
			reason: "DigiKey shipment tracking request failed",
		};
	const urlId = /ReviewOrder\/(\d{6,16})\b/i.exec(input.pageUrl)?.[1];
	const hintedIds = [
		...new Set(input.orderIdHints.filter((id) => /^\d{6,16}$/.test(id))),
	];
	const id = urlId ?? (hintedIds.length === 1 ? hintedIds[0] : undefined);
	if (!id)
		return {
			outcome: "no_orders",
			reason: "DigiKey shipment tracking lacks an unambiguous order number",
		};
	const trackingNumber =
		str(data.trackingNumber) ?? queryParam(requestUrl, "tnum");
	if (!trackingNumber || !/^[A-Z0-9-]{6,50}$/i.test(trackingNumber))
		return {
			outcome: "no_orders",
			reason: "DigiKey shipment tracking lacks a tracking number",
		};
	const current = isRecord(data.currentStatus) ? data.currentStatus : undefined;
	const status = str(current?.status) ?? str(data.status);
	const method = str(data.shipmentMethod) ?? queryParam(requestUrl, "method");
	const delivered =
		status && /^delivered\b/i.test(status)
			? (current ??
				records(data.activity).find((event) =>
					/^delivered\b/i.test(str(event.status) ?? ""),
				))
			: undefined;
	return buildResult(
		[
			{
				externalOrderId: id,
				merchantName: "DigiKey",
				orderUrl: `${origin(input.pageUrl)}/OrderHistory/ReviewOrder/${id}`,
				shipments: [
					{
						trackingNumber,
						carrier: detectCarrier(method) ?? method,
						status,
						deliveredAt: parseDate(str(delivered?.activityDateTime)),
					},
				],
			},
		],
		[],
		"no DigiKey shipment tracking data",
	);
}

function parseJson(input: ParserInput, body: unknown): ParseResult {
	const warnings: string[] = [];
	const data = unwrapBody(body);
	const site = origin(input.pageUrl);
	const hint = siteCurrency(input.pageUrl);
	const byId = new Map<string, ParsedOrder>();
	const get = (id: string): ParsedOrder => {
		let order = byId.get(id);
		if (!order) {
			order = {
				externalOrderId: id,
				merchantName: "DigiKey",
				orderUrl: `${site}/OrderHistory/ReviewOrder/${id}`,
			};
			byId.set(id, order);
		}
		return order;
	};
	for (const r of findRecords(data, (rec) => orderNumberOf(rec) !== undefined, {
		descendIntoMatches: false,
	})) {
		const id = resolveId(orderNumberOf(r) as string, input, warnings);
		if (!id) continue;
		const order = get(id);
		const currency =
			normalizeCurrencyCode(
				str(field(r, "currencyIso", "currency", "Currency", "currencyCode")),
			) ??
			order.currency ??
			hint;
		order.currency = currency;
		order.orderDate =
			order.orderDate ??
			parseDate(
				str(field(r, "dateEntered", "DateEntered", "orderDate", "createdDate")),
			);
		const statusText = str(
			field(
				r,
				"orderStatus",
				"status",
				"Status",
				"OrderStatus",
				"statusDescription",
			),
		);
		if (statusText && !/^\d+$/.test(statusText)) {
			order.statusText = statusText;
			order.status = normalizeStatus(statusText);
		}
		const po = str(
			field(r, "poNumber", "PurchaseOrderNumber", "customerPurchaseOrder"),
		);
		if (po && !order.paymentHint) order.paymentHint = `PO ${po}`;
		const invoices = records(field(r, "invoices", "Invoices"));
		if (invoices.length) {
			let subtotal = 0;
			let total = 0;
			let haveTotal = false;
			for (const inv of invoices) {
				subtotal += centsOrDecimal(field(inv, "orderValue"), currency) ?? 0;
				const t = decimalAmount(
					field(inv, "invoiceTotalPrice", "totalPrice"),
					currency,
				);
				if (t !== undefined) {
					total += t;
					haveTotal = true;
				}
				const invoiceId = str(field(inv, "invoiceId", "invoiceNumber"));
				if (invoiceId) {
					order.documentLinks = [
						...(order.documentLinks ?? []),
						{
							kind: "invoice",
							url: `${site}/OrderHistory/ReviewOrder/${id}?invoiceId=${encodeURIComponent(invoiceId)}`,
						},
					];
				}
			}
			if (subtotal) order.subtotalMinor = subtotal;
			if (haveTotal) order.totalMinor = total;
		}
		const pricing = records(field(r, "invoicePricing"));
		if (pricing.length) {
			order.taxMinor = pricing.reduce(
				(sum, p) => sum + (centsOrDecimal(field(p, "salesTax"), currency) ?? 0),
				0,
			);
			order.shippingMinor = pricing.reduce(
				(sum, p) =>
					sum + (centsOrDecimal(field(p, "freightValue"), currency) ?? 0),
				0,
			);
		}
		const lines = [
			...records(field(r, "invoiceDetails")),
			...records(field(r, "LineItems", "lineItems", "orderDetails", "details")),
		];
		if (lines.length) {
			const items = lines
				.map((l) => lineItem(l, currency, site))
				.filter((i) => i.title);
			order.items = [...(order.items ?? []), ...items];
		}
		const shipments: ParsedShipment[] = [];
		for (const s of records(
			field(
				r,
				"ShippingDetails",
				"shippingDetails",
				"shipments",
				"trackingInfo",
			),
		)) {
			const number = str(field(s, "TrackingNumber", "trackingNumber"));
			const carrier = str(field(s, "Carrier", "carrier", "CarrierName"));
			const url = str(field(s, "TrackingUrl", "trackingUrl"));
			const tracking =
				number ?? (url ? /([A-Z0-9]{10,34})\s*$/i.exec(url)?.[1] : undefined);
			if (tracking)
				shipments.push({
					trackingNumber: tracking,
					carrier: carrier ?? detectCarrier(url),
				});
		}
		if (shipments.length)
			order.shipments = [...(order.shipments ?? []), ...shipments];
		const totalTop = field(r, "TotalPrice", "orderTotal", "totalPrice");
		if (order.totalMinor === undefined && totalTop !== undefined)
			order.totalMinor = decimalAmount(totalTop, currency);
	}
	return buildResult(
		[...byId.values()],
		warnings,
		"no DigiKey orders in response",
	);
}

/* -------------------------------- HTML ---------------------------------- */

const SO_RE =
	/(?:sales\s*order|web\s*id|order)\s*(?:#|number|no\.?|nummer)?\s*:?\s*(\d{7,16})\b/i;

function parseHtml(input: ParserInput, html: string): ParseResult {
	const $: Doc = loadHtml(html);
	const site = origin(input.pageUrl);
	const lines = linesOf($("body").length ? $("body") : $.root());
	const text = lines.join("\n");
	const flat = cleanText(text);
	const urlId =
		/ReviewOrder\/(\d{6,16})/i.exec(input.pageUrl)?.[1] ??
		queryParam(input.pageUrl, "salesOrder");
	const id =
		urlId ??
		SO_RE.exec(flat)?.[1] ??
		input.orderIdHints.find((h) => /^\d{7,16}$/.test(h));
	if (!id) {
		const fallback = genericHtmlOrders($, input, {
			currencyHint: siteCurrency(input.pageUrl),
		});
		return buildResult(
			fallback.orders,
			fallback.warnings,
			fallback.reason || "no DigiKey order number on page",
		);
	}
	const currency = siteCurrency(input.pageUrl) ?? parseMoney(flat)?.currency;
	const opts = { currency };
	const items = tableItems($, undefined, site, currency);
	const order: ParsedOrder = {
		externalOrderId: id,
		merchantName: "DigiKey",
		orderUrl: `${site}/OrderHistory/ReviewOrder/${id}`,
		orderDate: dateFromText(flat),
		currency,
		subtotalMinor: moneyAfterLabel(
			text,
			/\b(?:subtotal|merchandise total)\b\s*:?/i,
			opts,
		)?.amountMinor,
		shippingMinor: moneyAfterLabel(
			text,
			/\b(?:shipping|freight)(?:\s*(?:&|and)\s*handling)?\b\s*:?/i,
			{ ...opts, allowFree: true },
		)?.amountMinor,
		taxMinor: moneyAfterLabel(
			text,
			/\b(?:sales\s+tax|tax|vat|gst)\b\s*:?/i,
			opts,
		)?.amountMinor,
		totalMinor:
			moneyAfterLabel(
				text,
				/\b(?:order total|grand total|invoice total)\b\s*:?/i,
				{ ...opts, last: true },
			)?.amountMinor ??
			moneyAfterLabel(text, /(?<!sub)\btotal\b\s*:?/i, { ...opts, last: true })
				?.amountMinor,
		statusText:
			/\b(?:order\s+)?status\s*:?\s*([A-Za-z][A-Za-z ]{2,30}?)(?:\s{2,}|\n|$)/i.exec(
				text,
			)?.[1],
		paymentLast4: extractLast4(flat),
		items: items.length ? items : undefined,
		documentLinks: documentLinks($, site),
	};
	order.status = normalizeStatus(order.statusText);
	return buildResult([order], [], "no DigiKey order data on page");
}

export const digikeyParser: StoreParser = {
	source: "digikey",
	version: 2,
	parse(input) {
		return safeParse("digikey", () => {
			const { payload } = input;
			if (payload.type === "json") {
				if (
					/\/OrderHistory\/api\/ShipmentTracking\/TrackingInfo\b/i.test(
						payload.requestUrl,
					)
				)
					return parseTracking(input, payload.requestUrl, payload.body);
				return parseJson(input, payload.body);
			}
			if (payload.type === "html") return parseHtml(input, payload.html);
			return {
				outcome: "unsupported",
				reason: "page_text captures go to AI extraction",
			};
		});
	},
};
