/**
 * eBay parser.
 *
 * JSON: purchase history `GET /mye/myebay/ajax/v2/purchase/mp/get` →
 *   `modules.RIVER[].data.items[]` wrappers with `itemCards[]` (order id in
 *   `__myb.orderId`), `primaryMessage` (status) and `secondaryMessage[]`
 *   label/value textSpans ("Order date", "Order total", "Order number").
 * HTML: purchase history `.m-order-card` (same data rendered) and the order
 *   details page `order.ebay.com/ord/show` (`.order-box`, `.order-info dl`,
 *   `.summary-region .payment-line-item dl`, `.shipment-info .tracking-info dl`).
 *   The order details page *is* the receipt.
 */
import { captureLocalDate } from "#/shared/capture-time";
import { parseDate } from "./dates";
import { genericHtmlOrders } from "./generic";
import {
	absUrl,
	type Doc,
	findAll,
	imageUrl,
	linesOf,
	loadHtml,
	type Sel,
	textOf,
} from "./html";
import {
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
import { cleanText, detectCarrier, extractLast4 } from "./text";
import type {
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
	ParseResult,
	ParserInput,
	StoreParser,
} from "./types";

const ORDER_ID_RE = /\b(?:\d{2}-\d{5}-\d{5}|\d{5,}-\d{5,})\b/;

function siteCurrency(url: string): string | undefined {
	try {
		const host = new URL(url).hostname;
		if (/ebay\.co\.uk$/.test(host)) return "GBP";
		if (/ebay\.(de|fr|it|es|nl|at|ie|be)$/.test(host)) return "EUR";
		if (/ebay\.ca$/.test(host)) return "CAD";
		if (/ebay\.com\.au$/.test(host)) return "AUD";
		if (/ebay\.ch$/.test(host)) return "CHF";
		if (/ebay\.pl$/.test(host)) return "PLN";
		return "USD";
	} catch {
		return undefined;
	}
}

/** Flattens eBay "textual display" objects ({textSpans:[{text}]}) to text. */
function textual(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return value.map(textual).filter(Boolean).join(" ");
	if (!isRecord(value)) return "";
	if (Array.isArray(value.textSpans))
		return value.textSpans.map(textual).join("");
	if (typeof value.text === "string") return value.text;
	return Object.entries(value)
		.filter(
			([key]) =>
				![
					"accessibilityText",
					"url",
					"URL",
					"action",
					"trackingList",
					"_type",
				].includes(key),
		)
		.map(([, child]) => textual(child))
		.filter(Boolean)
		.join(" ");
}

/** "Order date:" → "order date" (labels come with and without the colon). */
function labelKey(text: string): string {
	return text.replace(/\s*:\s*$/, "").toLowerCase();
}

/** Label/value pairs from secondaryMessage-like arrays. */
function labelPairs(messages: unknown): Map<string, string> {
	const texts = (Array.isArray(messages) ? messages : []).map((m) =>
		cleanText(textual(m)),
	);
	const out = new Map<string, string>();
	texts.forEach((text, i) => {
		// The value must not start with the label's own colon ("Order date:"
		// alone is a label whose value is the next span).
		const inline =
			/^(order (?:date|total|number)|bestelldatum|bestellsumme|bestellnummer)\s*:?\s*([^:\s].*)$/i.exec(
				text,
			);
		if (inline?.[1] && inline[2]) out.set(inline[1].toLowerCase(), inline[2]);
		else if (
			/^(order (date|total|number)|bestelldatum|bestellsumme|bestellnummer)$/i.test(
				labelKey(text),
			) &&
			texts[i + 1]
		)
			out.set(labelKey(text), texts[i + 1] as string);
	});
	if (!out.size && texts.length >= 4) {
		// Positional fallback seen in 2026 responses: [label, date, label, total, label, number].
		out.set("order date", texts[1] as string);
		out.set("order total", texts[3] as string);
		if (texts[5]) out.set("order number", texts[5]);
	}
	return out;
}

function quantityAndVariant(aspects: unknown): {
	quantity: number;
	variant?: string;
} {
	let quantity = 1;
	const variant: string[] = [];
	for (const aspect of Array.isArray(aspects) ? aspects : []) {
		const text = cleanText(textual(aspect));
		const q = /^(?:quantity|qty|anzahl|menge|amount)\s*:?\s*(\d+)/i.exec(text);
		if (q) quantity = Number(q[1]);
		else if (text) variant.push(text);
	}
	return { quantity, variant: variant.length ? variant.join(", ") : undefined };
}

function moneyOf(
	value: unknown,
	currencyHint: string | undefined,
): { minor?: number; currency?: string } {
	if (isRecord(value)) {
		const inner = isRecord(value.value) ? value.value : value;
		const currency =
			normalizeCurrencyCode(str(inner.currency) ?? str(inner.currencyCode)) ??
			currencyHint;
		const amount = num(inner.value) ?? num(inner.amount);
		if (amount !== undefined)
			return { minor: toMinor(amount, currency), currency };
		return moneyOf(textual(value), currency);
	}
	const parsed = parseMoney(textual(value), { currency: currencyHint });
	return { minor: parsed?.amountMinor, currency: parsed?.currency };
}

function orderUrlIn(record: unknown): string | undefined {
	const json = JSON.stringify(record);
	const m = /https?:\/\/order\.ebay\.[a-z.]+\/ord\/show\?[^"\s]+/.exec(json);
	return m?.[0].replace(/\\u0026/g, "&");
}

function wrapperToOrder(
	wrapper: JsonRecord,
	currencyHint: string | undefined,
	warnings: string[],
): ParsedOrder | undefined {
	const cards = records(wrapper.itemCards);
	const pairs = labelPairs(wrapper.secondaryMessage);
	const id =
		cards
			.map((c) => (isRecord(c.__myb) ? str(c.__myb.orderId) : undefined))
			.find(Boolean) ??
		ORDER_ID_RE.exec(
			pairs.get("order number") ?? pairs.get("bestellnummer") ?? "",
		)?.[0];
	if (!id) {
		warnings.push("ebay: purchase wrapper without an order id");
		return undefined;
	}
	const totalText = pairs.get("order total") ?? pairs.get("bestellsumme");
	const total = totalText
		? parseMoney(totalText, { currency: currencyHint })
		: undefined;
	const currency = total?.currency ?? currencyHint;
	const sellers = new Set<string>();
	const items: ParsedItem[] = cards.map((card) => {
		const myb = isRecord(card.__myb) ? card.__myb : {};
		const seller = cleanText(textual(records(myb.sellerInfo)[1] ?? ""));
		if (seller) sellers.add(seller);
		const image = isRecord(card.image) ? card.image : {};
		const { quantity, variant } = quantityAndVariant(card.aspectValuesList);
		const price = moneyOf(card.additionalPrice, currency);
		const listingId = str(card.listingId);
		return {
			externalItemId: listingId,
			sku: listingId,
			title: cleanText(textual(card.title)) || str(image.title) || "",
			variant,
			quantity,
			unitPriceMinor: quantity === 1 ? price.minor : undefined,
			totalMinor: price.minor,
			imageUrl: str(image.URL) ?? str(image.url),
			itemUrl: listingId ? `https://www.ebay.com/itm/${listingId}` : undefined,
		};
	});
	const statusText = cleanText(textual(wrapper.primaryMessage)) || undefined;
	const url = orderUrlIn(wrapper);
	return {
		externalOrderId: id,
		merchantName: sellers.size === 1 ? [...sellers][0] : undefined,
		orderUrl:
			url ??
			`https://order.ebay.com/ord/show?orderId=${encodeURIComponent(id)}#/`,
		orderDate: parseDate(pairs.get("order date") ?? pairs.get("bestelldatum")),
		statusText,
		status: normalizeStatus(statusText),
		currency,
		totalMinor: total?.amountMinor,
		items,
		itemsPartial: true,
	};
}

function parseJson(input: ParserInput, body: unknown): ParseResult {
	const warnings: string[] = [];
	const data = unwrapBody(body);
	const currencyHint = siteCurrency(input.pageUrl);
	const wrappers = findRecords(data, (r) => Array.isArray(r.itemCards), {
		maxDepth: 12,
	});
	const orders = wrappers
		.map((w) => wrapperToOrder(w, currencyHint, warnings))
		.filter((o): o is ParsedOrder => Boolean(o));
	return buildResult(
		orders,
		warnings,
		"no eBay purchases in response (empty page or unrelated API)",
	);
}

/* -------------------------------- HTML ---------------------------------- */

function dlPairs(
	$: Doc,
	scope: Sel,
	selector: string,
): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	findAll($, scope, selector).each((_, el) => {
		const dl = $(el);
		const dts = dl.find("dt");
		dts.each((i, dt) => {
			const label = textOf($(dt));
			const dd = $(dt).nextAll("dd").first();
			const value = textOf(dd.length ? dd : dl.find("dd").eq(i));
			if (label) pairs.push([label, value]);
		});
	});
	return pairs;
}

function parseListHtml($: Doc, input: ParserInput): ParsedOrder[] {
	const currencyHint = siteCurrency(input.pageUrl);
	const orders: ParsedOrder[] = [];
	findAll($, undefined, ".m-order-card").each((_, el) => {
		const card = $(el);
		const pairs = new Map<string, string>();
		findAll($, card, ".secondaryMessage .primary__item--wrapper").each(
			(_, w) => {
				const spans = $(w).find(".primary__item--item-text");
				pairs.set(labelKey(textOf(spans.eq(0))), textOf(spans.eq(1)));
			},
		);
		const detailsLink = card
			.find("a")
			.filter((_, a) =>
				/ord\/show|order details/i.test(
					`${$(a).attr("href") ?? ""} ${textOf($(a))}`,
				),
			)
			.first();
		const href = absUrl(detailsLink.attr("href"), input.pageUrl);
		const id =
			ORDER_ID_RE.exec(pairs.get("order number") ?? "")?.[0] ??
			ORDER_ID_RE.exec(queryParam(href, "orderId") ?? "")?.[0];
		if (!id) return;
		const total = parseMoney(pairs.get("order total"), {
			currency: currencyHint,
			allowFree: true,
		});
		const items: ParsedItem[] = [];
		findAll($, card, ".m-item-card").each((_, itemEl) => {
			const item = $(itemEl);
			const listingId = item
				.find("[input-listing-id]")
				.first()
				.attr("input-listing-id");
			const aspects = item
				.find(
					".item-info-aspectValuesList > div, .item-info-aspectValuesList span",
				)
				.toArray()
				.map((a) => textOf($(a)));
			const { quantity, variant } = quantityAndVariant(aspects);
			const price = parseMoney(
				textOf(item.find(".item-info-additionalPrice").first()),
				{ currency: total?.currency ?? currencyHint },
			);
			items.push({
				externalItemId: listingId,
				sku: listingId,
				title: textOf(item.find(".item-info-title").first()),
				variant,
				quantity,
				totalMinor: price?.amountMinor,
				unitPriceMinor: quantity === 1 ? price?.amountMinor : undefined,
				imageUrl: imageUrl(item.find("img"), input.pageUrl),
				itemUrl: listingId
					? `https://www.ebay.com/itm/${listingId}`
					: undefined,
			});
		});
		const statusText =
			textOf(card.find(".primaryMessage, .order-status").first()) || undefined;
		orders.push({
			externalOrderId: id,
			orderUrl: href,
			orderDate: parseDate(pairs.get("order date")),
			statusText,
			status: normalizeStatus(statusText),
			currency: total?.currency ?? currencyHint,
			totalMinor: total?.amountMinor,
			items,
			itemsPartial: true,
		});
	});
	return orders;
}

function parseDetailHtml(
	$: Doc,
	input: ParserInput,
	warnings: string[],
): ParsedOrder[] {
	const currencyHint = siteCurrency(input.pageUrl);
	const page = $(".main-regions").length
		? $(".main-regions").first()
		: $("body");
	const pageText = textOf(page);
	if (/order\s+not\s+found|error retrieving your order/i.test(pageText))
		return [];
	let boxes = findAll($, page, ".order-box");
	if (boxes.length === 0) boxes = page;
	const summary = $(".summary-region").first();
	const summaryPairs = dlPairs($, summary, "dl");
	const orders: ParsedOrder[] = [];
	boxes.each((_, el) => {
		const box = $(el);
		const info = new Map(
			dlPairs($, box, ".order-info dl").map(([k, v]) => [k.toLowerCase(), v]),
		);
		const id =
			ORDER_ID_RE.exec(
				info.get("order number") ?? info.get("bestellnummer") ?? "",
			)?.[0] ??
			(boxes.length === 1
				? ORDER_ID_RE.exec(queryParam(input.pageUrl, "orderId") ?? "")?.[0]
				: undefined);
		if (!id) return;
		const items: ParsedItem[] = [];
		findAll($, box, "[class*='m-item-card'], .item-card").each((_, itemEl) => {
			const item = $(itemEl);
			if (item.parents("[class*='m-item-card']").length) return;
			const link = item
				.find("a[href*='/itm/']")
				.filter((_, a) => textOf($(a)).length > 0)
				.first();
			const title =
				textOf(link) || textOf(item.find(".item-title, h3").first());
			if (!title) return;
			const href =
				link.attr("href") ?? item.find("a[href*='/itm/']").first().attr("href");
			const itemNumber = /\/itm\/(?:[^/]+\/)?(\d{9,15})/.exec(href ?? "")?.[1];
			const lines = linesOf(item);
			const qtyLine = lines.find((l) => /^(quantity|qty|anzahl)\b/i.test(l));
			const quantity = Number(/(\d+)/.exec(qtyLine ?? "")?.[1] ?? "1") || 1;
			const priceLine = lines.find(
				(l) =>
					/(US\s?\$|C\s?\$|AU\s?\$|\$|£|€|EUR)\s?\d/.test(l) &&
					!/shipping|postage/i.test(l),
			);
			const price = priceLine
				? parseMoney(priceLine, { currency: currencyHint })
				: undefined;
			const aspectLines = lines.filter(
				(l) =>
					/^[A-Z][\w\s]{1,24}:\s*\S/.test(l) &&
					!/^(quantity|qty|item number|sold by|returns?|price)\b/i.test(l),
			);
			items.push({
				externalItemId: itemNumber,
				sku: itemNumber,
				title,
				variant: aspectLines.length ? aspectLines.join(", ") : undefined,
				quantity,
				unitPriceMinor: price
					? quantity > 1
						? Math.round(price.amountMinor / quantity)
						: price.amountMinor
					: undefined,
				totalMinor: price?.amountMinor,
				imageUrl: imageUrl(item.find("img"), input.pageUrl),
				itemUrl: itemNumber
					? `https://www.ebay.com/itm/${itemNumber}`
					: absUrl(href, input.pageUrl),
			});
		});
		const shipments: ParsedShipment[] = [];
		findAll($, box, ".shipment-info, .shipment-card").each((_, s) => {
			const ship = $(s);
			const pairs = dlPairs($, ship, ".tracking-info dl");
			const number = pairs.find(([k]) =>
				/number|nummer|tracking/i.test(k),
			)?.[1];
			if (!number) return;
			const carrier = pairs.find(([k]) =>
				/carrier|versand|shipping service|service/i.test(k),
			)?.[1];
			shipments.push({
				trackingNumber: number.replace(/\s+/g, ""),
				// Item titles and requested shipping-service rows are not evidence
				// of the carrier that actually received this shipment.
				carrier: carrier ?? detectCarrier(textOf(ship.find(".tracking-info"))),
				status:
					textOf(ship.find(".shipment-card-sub-title").first()) || undefined,
			});
		});
		const statusText =
			textOf(box.find(".shipment-card-sub-title").first()) ||
			textOf(box.find(".order-status, .status-message").first()) ||
			undefined;
		const placed =
			info.get("time placed") ??
			info.get("order date") ??
			info.get("date paid") ??
			info.get("bestelldatum");
		// Each box of a combined checkout shows its own "Total $19.43 (1 item)";
		// the summary region below only covers the whole purchase.
		const boxTotal = parseMoney(
			(info.get("total") ?? info.get("gesamtbetrag"))?.replace(/\(.*\)/, ""),
			{ currency: currencyHint },
		);
		const orderUrl = `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(id)}#/`;
		// Checkout-wide summary amounts cannot be allocated to sibling orders.
		// Only use tax/shipping rows explicitly contained in this order's box.
		const localAmounts: Pick<ParsedOrder, "shippingMinor" | "taxMinor"> = {};
		if (boxes.length > 1) {
			for (const [label, value] of dlPairs(
				$,
				box,
				".order-info dl, .summary-region dl, .order-summary dl, .payment-line-item dl",
			)) {
				const money = parseMoney(value, {
					currency: currencyHint,
					allowFree: true,
				});
				if (!money) continue;
				if (/shipping|postage|versand/i.test(label))
					localAmounts.shippingMinor =
						(localAmounts.shippingMinor ?? 0) + money.amountMinor;
				else if (/tax|vat|gst|mwst/i.test(label))
					localAmounts.taxMinor =
						(localAmounts.taxMinor ?? 0) + money.amountMinor;
			}
		}
		orders.push({
			externalOrderId: id,
			merchantName: info.get("sold by") ?? info.get("verkäufer") ?? undefined,
			orderUrl,
			orderDate: parseDate(placed),
			statusText,
			status: normalizeStatus(statusText),
			currency: boxTotal?.currency ?? currencyHint,
			totalMinor: boxTotal?.amountMinor,
			items: items.length ? items : undefined,
			shipments,
			documentLinks: [{ kind: "receipt", url: orderUrl }],
			...localAmounts,
		});
	});
	if (boxes.length === 1 && orders.length === 1 && orders[0]) {
		const order = orders[0];
		let paidMinor: number | undefined;
		let refundedMinor: number | undefined;
		for (const [label, value] of summaryPairs) {
			const money = parseMoney(value, {
				currency: currencyHint,
				allowFree: true,
			});
			if (!money) continue;
			order.currency = money.currency ?? order.currency;
			if (/refund|erstattet/i.test(label))
				refundedMinor = (refundedMinor ?? 0) + Math.abs(money.amountMinor);
			else if (/amount paid|bezahlter betrag/i.test(label))
				paidMinor = money.amountMinor;
			else if (
				/order total|total charged|^total$|gesamtbetrag|bestellsumme/i.test(
					label,
				)
			)
				order.totalMinor = money.amountMinor;
			// Before "items": "Item discount" is a discount, not the subtotal.
			else if (/discount|coupon|promo|savings|rabatt|gutschein/i.test(label))
				order.discountMinor =
					(order.discountMinor ?? 0) + Math.abs(money.amountMinor);
			else if (
				/subtotal|item(s)?\s*\(|^items?\b|^\d+\s+items?\b|artikel/i.test(label)
			)
				order.subtotalMinor = money.amountMinor;
			else if (/shipping|postage|versand/i.test(label))
				order.shippingMinor = (order.shippingMinor ?? 0) + money.amountMinor;
			else if (/tax|vat|gst|mwst/i.test(label))
				order.taxMinor = (order.taxMinor ?? 0) + money.amountMinor;
		}
		// Fully refunded: eBay nets "Order total" to 0 but keeps the shipment's
		// "Delivered" line; the order is a return, not a $0 purchase.
		if (
			refundedMinor !== undefined &&
			refundedMinor > 0 &&
			refundedMinor >= (paidMinor ?? order.totalMinor ?? Infinity)
		) {
			order.status = "returned";
			order.statusText = "Refunded";
		}
		const paymentText =
			textOf($(".payment-info, .payment-method, .payment-region").first()) ||
			textOf(summary);
		order.paymentLast4 = extractLast4(paymentText);
		const brand =
			/\b(PayPal|Visa|Mastercard|American Express|Amex|Discover|Apple Pay|Google Pay|Klarna)\b/i.exec(
				paymentText,
			)?.[1];
		if (brand)
			order.paymentHint = order.paymentLast4
				? `${brand} ending in ${order.paymentLast4}`
				: brand;
	} else if (orders.some((o) => o.totalMinor === undefined)) {
		warnings.push(
			"ebay: page holds several orders; purchase totals not attributed",
		);
	}
	return orders;
}

const STRICT_ORDER_ID_RE = /^(?:\d{2}-\d{5}-\d{5}|\d{5,}-\d{5,})$/;

/**
 * Checkout success page (pay.ebay.com/rxo?action=success): the order summary
 * row "Order <id>" and the page's `__xo` state object
 * (`"orderTotal":"$97.14","orderNumber":"14-…"`).
 */
function parseConfirmationHtml(
	$: Doc,
	input: ParserInput,
	html: string,
): ParsedOrder[] {
	// Several modules carry an `__xo` block; the order summary has orderNumber.
	const xo =
		[...html.matchAll(/"__xo"\s*:\s*\{([^{}]{0,4000})/g)]
			.map((m) => m[1] ?? "")
			.find((block) => block.includes('"orderNumber"')) ?? "";
	const field = (name: string) =>
		new RegExp(`"${name}"\\s*:\\s*"([^"]{1,200})"`).exec(xo)?.[1];
	let id = ORDER_ID_RE.exec(field("orderNumber") ?? "")?.[0];
	if (!id)
		$(".success-evo--order-summary-item").each((_, el) => {
			const row = $(el);
			if (
				!id &&
				/^order$/i.test(
					textOf(row.find(".success-evo--order-summary-item-label")),
				)
			)
				id = ORDER_ID_RE.exec(
					textOf(row.find(".success-evo--order-summary-item-description")),
				)?.[0];
		});
	if (!id) return [];
	let orderDate = parseDate(field("orderDate") ?? field("purchaseDate"));
	if (!orderDate)
		$(".success-evo--order-summary-item").each((_, el) => {
			const row = $(el);
			if (
				/^(order date|date placed|time placed|purchase date)$/i.test(
					textOf(row.find(".success-evo--order-summary-item-label")),
				)
			)
				orderDate ??= parseDate(
					textOf(row.find(".success-evo--order-summary-item-description")),
				);
		});
	orderDate ??= parseDate(
		input.capturedLocalDate ?? captureLocalDate(input.capturedAt),
	);
	const total = parseMoney(field("orderTotal") ?? "", {
		currency: siteCurrency(input.pageUrl),
	});
	return [
		{
			externalOrderId: id,
			orderUrl: `https://order.ebay.com/ord/show?orderId=${encodeURIComponent(id)}#/`,
			orderDate,
			checkoutEmailDomain: /@([a-z0-9.-]+)$/i
				.exec(field("emailAddress") ?? "")?.[1]
				?.toLowerCase(),
			status: "placed",
			currency: total?.currency,
			totalMinor: total?.amountMinor,
		},
	];
}

function parseHtml(input: ParserInput, html: string): ParseResult {
	const warnings: string[] = [];
	if (/limitexceeded/i.test(input.pageUrl))
		return { outcome: "no_orders", reason: "eBay rate limit page" };
	const $ = loadHtml(html);
	const isDetail =
		/ord\/show|FetchOrderDetails/i.test(input.pageUrl) ||
		$(".order-box, .order-info").length > 0;
	const orders = /^https:\/\/pay\.ebay\./i.test(input.pageUrl)
		? parseConfirmationHtml($, input, html)
		: isDetail
			? parseDetailHtml($, input, warnings)
			: parseListHtml($, input);
	if (orders.length === 0) {
		const fallback = genericHtmlOrders($, input, {
			allowText: false,
			currencyHint: siteCurrency(input.pageUrl),
		});
		// Data layers carry item/transaction ids ("-1" for uncommitted items).
		orders.push(
			...fallback.orders.filter((o) =>
				STRICT_ORDER_ID_RE.test(o.externalOrderId),
			),
		);
	}
	return buildResult(orders, warnings, "no eBay orders found on page");
}

export const ebayParser: StoreParser = {
	source: "ebay",
	version: 7,
	parse(input) {
		return safeParse("ebay", () => {
			const { payload } = input;
			if (payload.type === "json") return parseJson(input, payload.body);
			if (payload.type === "html") return parseHtml(input, payload.html);
			return {
				outcome: "unsupported",
				reason: "page_text captures go to AI extraction",
			};
		});
	},
};
