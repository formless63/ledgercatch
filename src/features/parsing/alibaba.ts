/**
 * Alibaba.com (buyer side, biz.alibaba.com) parser. LOW CONFIDENCE: no
 * maintained open-source buyer exporter exists; shapes are inferred.
 *
 * JSON: any response is walked for order-like records (an 18-digit
 * `orderId`/`tradeOrderId`/`orderIdStr`/`id` plus an amount, status, date or
 * product list). Amounts may be numbers, strings ("USD 123.45") or
 * `{ amount|value, currency|currencyCode }`. 18-digit numeric ids exceed 2^53,
 * so string variants, the request URL and hints win over numbers.
 * HTML: Trade Assurance detail labels ("Order No.", "Product total",
 * "Shipping fee", "Total amount", "Supplier"), any product table, then the
 * generic structured/text fallback.
 */
import { parseDate } from "./dates";
import { genericHtmlOrders } from "./generic";
import { dateFromText } from "./heuristics";
import {
	absUrl,
	type Doc,
	documentLinks,
	linesOf,
	loadHtml,
	pickText,
	type Sel,
	textOf,
} from "./html";
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
import { cleanText, extractLast4, moneyAfterLabel } from "./text";
import type {
	ParsedItem,
	ParsedOrder,
	ParseResult,
	ParserInput,
	StoreParser,
} from "./types";

const ID_RE = /^\d{12,20}$/;
const BASE = "https://biz.alibaba.com";

function externalIds(input: ParserInput, requestUrl?: string): string[] {
	return [
		queryParam(requestUrl, "orderId"),
		queryParam(requestUrl, "tradeOrderId"),
		/"(?:orderId|tradeOrderId)"\s*:\s*"?(\d{12,20})/.exec(
			decodeURIComponent(queryParam(requestUrl, "data") ?? ""),
		)?.[1],
		queryParam(input.pageUrl, "orderId"),
		...input.orderIdHints,
	].filter((v): v is string => Boolean(v && ID_RE.test(v)));
}

function idOf(
	r: JsonRecord,
	external: string[],
	warnings: string[],
): string | undefined {
	for (const key of [
		"orderIdStr",
		"tradeOrderIdStr",
		"idStr",
		"orderId",
		"tradeOrderId",
		"orderNo",
		"id",
	]) {
		const v = r[key];
		if (typeof v === "string" && ID_RE.test(v.trim())) return v.trim();
		if (typeof v === "number" && Number.isFinite(v) && v > 1e11) {
			if (Number.isSafeInteger(v)) return String(v);
			const match = external.find((e) => Number(e) === v);
			if (match) return match;
			warnings.push(
				"alibaba: numeric order id exceeds 2^53 and no matching URL/hint id",
			);
		}
	}
	return undefined;
}

function amountOf(
	value: unknown,
	currencyHint: string | undefined,
): { minor?: number; currency?: string } {
	if (value === undefined || value === null) return {};
	if (isRecord(value)) {
		const currency =
			normalizeCurrencyCode(
				str(field(value, "currency", "currencyCode", "currencyType")),
			) ?? currencyHint;
		const cent = num(field(value, "cent", "cents", "amountInCent"));
		if (cent !== undefined) return { minor: Math.round(cent), currency };
		return amountOf(
			field(value, "amount", "value", "price", "formatPrice", "amountStr"),
			currency,
		);
	}
	const n = num(value);
	if (n !== undefined)
		return { minor: toMinor(n, currencyHint), currency: currencyHint };
	const parsed = parseMoney(str(value), { currency: currencyHint });
	return {
		minor: parsed?.amountMinor,
		currency: parsed?.currency ?? currencyHint,
	};
}

const AMOUNT_KEYS = [
	"totalAmount",
	"orderAmount",
	"actualPayAmount",
	"actualPayFee",
	"payAmount",
	"totalPrice",
	"orderTotalAmount",
	"totalFee",
];
const PRODUCT_KEYS = [
	"productList",
	"orderProducts",
	"productInfos",
	"itemList",
	"products",
	"orderItems",
	"lineItems",
	"productInfoList",
];

function looksLikeOrder(r: JsonRecord): boolean {
	const hasId = [
		"orderIdStr",
		"tradeOrderIdStr",
		"orderId",
		"tradeOrderId",
		"orderNo",
	].some((k) => {
		const v = r[k];
		return (
			(typeof v === "string" && ID_RE.test(v.trim())) ||
			(typeof v === "number" && v > 1e11)
		);
	});
	if (!hasId) return false;
	return (
		AMOUNT_KEYS.some((k) => r[k] !== undefined) ||
		PRODUCT_KEYS.some((k) => Array.isArray(r[k])) ||
		r.orderStatus !== undefined ||
		r.gmtCreate !== undefined ||
		r.createTime !== undefined
	);
}

function productItems(
	r: JsonRecord,
	currency: string | undefined,
): ParsedItem[] {
	const items: ParsedItem[] = [];
	for (const key of PRODUCT_KEYS) {
		for (const p of records(r[key])) {
			const quantity =
				num(
					field(p, "quantity", "productQuantity", "buyAmount", "count", "num"),
				) ?? 1;
			const unit = amountOf(
				field(p, "unitPrice", "price", "productPrice", "itemPrice"),
				currency,
			);
			const total = amountOf(
				field(p, "totalPrice", "amount", "subtotal", "productTotalAmount"),
				unit.currency ?? currency,
			);
			const url = str(
				field(p, "productUrl", "detailUrl", "productDetailUrl", "url"),
			);
			const img = str(
				field(p, "imageUrl", "productImage", "imgUrl", "image", "picUrl"),
			);
			items.push({
				externalItemId: str(field(p, "productId", "itemId", "skuId")),
				title:
					str(
						field(p, "productName", "subject", "name", "title", "productTitle"),
					) ?? "",
				sku: str(field(p, "skuId", "productCode", "model", "productId")),
				variant: str(
					field(p, "skuInfo", "skuAttr", "specification", "skuDesc"),
				),
				quantity,
				unitPriceMinor: unit.minor,
				totalMinor:
					total.minor ??
					(unit.minor !== undefined ? unit.minor * quantity : undefined),
				imageUrl: img ? absUrl(img, BASE) : undefined,
				itemUrl: url ? absUrl(url, "https://www.alibaba.com/") : undefined,
			});
		}
	}
	return items.filter((i) => i.title);
}

function parseJson(
	input: ParserInput,
	body: unknown,
	requestUrl: string,
): ParseResult {
	// Cashier availability and payment-step amounts are not order facts.
	if (
		/cashier\.alibaba\.com\/payment\/|\/list\/ajax\/ta\/order\/trace\.json|mtop\.alibaba\.intl\.camel\.ai\.tradeagent\./i.test(
			requestUrl,
		)
	)
		return { outcome: "no_orders", reason: "non-order Alibaba API" };
	const warnings: string[] = [];
	const data = unwrapBody(body);
	const ret = isRecord(data) ? data.ret : undefined;
	if (
		Array.isArray(ret) &&
		typeof ret[0] === "string" &&
		!ret[0].startsWith("SUCCESS")
	)
		return { outcome: "no_orders", reason: `MTOP error: ${ret[0]}` };
	const external = externalIds(input, requestUrl);
	const orders: ParsedOrder[] = [];
	for (const r of findRecords(data, looksLikeOrder)) {
		const id = idOf(r, external, warnings);
		if (!id) continue;
		const currencyHint =
			normalizeCurrencyCode(
				str(field(r, "currency", "currencyCode", "payCurrency")),
			) ?? "USD";
		const amountKey = AMOUNT_KEYS.find((k) => r[k] !== undefined);
		const total = amountOf(amountKey ? r[amountKey] : undefined, currencyHint);
		const currency = total.currency ?? currencyHint;
		const statusText = str(
			field(
				r,
				"orderStatusText",
				"statusText",
				"orderStatusDesc",
				"statusDesc",
				"orderStatus",
				"status",
			),
		);
		const items = productItems(r, currency);
		const seller = field(
			r,
			"sellerCompanyName",
			"supplierCompanyName",
			"supplierName",
			"sellerName",
			"companyName",
		);
		const shipping = amountOf(
			field(r, "shippingFee", "freight", "shippingAmount", "logisticsFee"),
			currency,
		);
		const subtotal = amountOf(
			field(r, "productAmount", "productTotalAmount", "goodsAmount"),
			currency,
		);
		const tax = amountOf(field(r, "taxAmount", "tax", "taxFee"), currency);
		const discount = amountOf(
			field(r, "discountAmount", "couponAmount", "promotionAmount"),
			currency,
		);
		orders.push({
			externalOrderId: id,
			merchantName: isRecord(seller) ? str(seller.name) : str(seller),
			orderUrl: `${BASE}/ta/detail.htm?orderId=${id}`,
			orderDate: parseDate(
				(field(
					r,
					"gmtCreate",
					"createTime",
					"orderCreateTime",
					"gmtOrderCreate",
					"orderDate",
				) as string | number | undefined) ?? undefined,
			),
			statusText:
				statusText && !/^\d+$/.test(statusText)
					? statusText.replace(/_/g, " ").toLowerCase()
					: undefined,
			status:
				statusText && !/^\d+$/.test(statusText)
					? normalizeStatus(statusText.replace(/_/g, " "))
					: undefined,
			currency,
			totalMinor: total.minor,
			subtotalMinor: subtotal.minor,
			shippingMinor: shipping.minor,
			taxMinor: tax.minor,
			discountMinor: discount.minor,
			items: items.length ? items : undefined,
		});
	}
	return buildResult(orders, warnings, "no Alibaba orders in response");
}

/** Current buyer UI uses separate header/body tables and contract-only titles. */
function buyerItems(
	$: Doc,
	scope: Sel,
	base: string,
	currency: string,
): ParsedItem[] {
	const items: ParsedItem[] = [];
	scope
		.find("tr")
		.has(".product-name")
		.each((_, el) => {
			const row = $(el);
			const title = textOf(row.find(".product-name"));
			const quantity = num(textOf(row.find(".product-quantity-cell"))) ?? 1;
			const unit = parseMoney(textOf(row.find(".product-unitPrice-cell")), {
				currency,
			});
			const total = parseMoney(
				textOf(row.find(".product-subtotalPrice-cell")),
				{ currency },
			);
			if (title)
				items.push({
					title,
					quantity,
					unitPriceMinor: unit?.amountMinor,
					totalMinor: total?.amountMinor,
					variant: textOf(row.find(".product-sku-cell")) || undefined,
					itemUrl: absUrl(row.find(".product-name a").attr("href"), base),
				});
		});
	scope.find(".product-item").each((_, el) => {
		const row = $(el);
		const title = textOf(row.find(".product-desc"));
		const quantity = Number(
			/x\s*([\d,.]+)\s*items/i.exec(textOf(row))?.[1]?.replace(/,/g, "") ?? 1,
		);
		if (title)
			items.push({
				title,
				quantity,
				itemUrl: absUrl(row.find(".product-desc a").attr("href"), base),
			});
	});
	if (!items.length) {
		scope
			.find('[data-i18n-key="detail.contract.attachment.product_name"]')
			.each((_, el) => {
				const title = textOf($(el).parent().next());
				if (title) items.push({ title, quantity: 1 });
			});
	}
	return items;
}

function buyerStatus(text: string | undefined) {
	if (text && /waiting for payment/i.test(text)) return "placed" as const;
	if (
		text &&
		/waiting for supplier to ship|payment being processed/i.test(text)
	)
		return "processing" as const;
	if (text && /waiting for delivery confirmation/i.test(text))
		return "shipped" as const;
	return normalizeStatus(text);
}

function parseHtml(input: ParserInput, html: string): ParseResult {
	const $ = loadHtml(html);
	const lines = linesOf($("body").length ? $("body") : $.root());
	const text = lines.join("\n");
	const flat = cleanText(text);
	const cards = $(".order-list-item");
	if (cards.length) {
		const orders: ParsedOrder[] = [];
		cards.each((_, el) => {
			const card = $(el);
			const id = /\d{12,20}/.exec(textOf(card.find(".order-id")))?.[0];
			if (!id) return;
			const total = parseMoney(textOf(card.find(".order-amount")), {
				currency: "USD",
			});
			const currency = total?.currency ?? "USD";
			const statusText = textOf(card.find(".order-status")) || undefined;
			orders.push({
				externalOrderId: id,
				orderUrl: `${BASE}/ta/detail.htm?orderId=${id}`,
				merchantName: textOf(card.find(".supplier-name")) || undefined,
				orderDate: dateFromText(textOf(card.find(".order-date"))),
				statusText,
				status: buyerStatus(statusText),
				currency,
				totalMinor: total?.amountMinor,
				items: buyerItems($, card, input.pageUrl, currency),
				itemsPartial: true,
			});
		});
		return buildResult(orders, [], "no Alibaba order cards");
	}
	const id =
		queryParam(input.pageUrl, "orderId") ??
		/order\s*(?:no\.?|number|id|#)\s*:?\s*(\d{12,20})/i.exec(flat)?.[1] ??
		input.orderIdHints.find((h) => ID_RE.test(h));
	if (!id || !ID_RE.test(id)) {
		const fallback = genericHtmlOrders($, input, { currencyHint: "USD" });
		return buildResult(
			fallback.orders,
			fallback.warnings,
			fallback.reason || "no Alibaba order number on page",
		);
	}
	const summaryMoney = (label: RegExp) => {
		const row = $(".order-summary-item")
			.filter((_, el) => label.test(textOf($(el).find(".order-summary-label"))))
			.first();
		return parseMoney(textOf(row.find(".order-summary-value").first()), {
			currency: "USD",
		});
	};
	const total =
		summaryMoney(/^total$/i) ??
		moneyAfterLabel(
			text,
			/\b(?:total amount|order total|total price|amount to pay|total payment|grand total)\b\s*:?/i,
			{ currency: "USD", last: true },
		) ??
		moneyAfterLabel(text, /(?<!product\s)(?<!sub)\btotal\b\s*:?/i, {
			currency: "USD",
			last: true,
		});
	const currency = total?.currency ?? "USD";
	const opts = { currency };
	const buyer = buyerItems($, $.root(), input.pageUrl, currency);
	const items = buyer.length
		? buyer
		: tableItems($, undefined, input.pageUrl, currency);
	const supplier =
		pickText($, undefined, [
			".supplier-name",
			".company-name",
			"[class*='supplier'] a",
			"[class*='seller-name']",
		]) ?? /(?:supplier|seller)\s*:?\s*([^\n]{3,80})/i.exec(text)?.[1];
	const statusText =
		(textOf($(".status-title")).replace(/^order status\s*:\s*/i, "") ||
			undefined) ??
		/\b(?:order\s+)?status\s*:?\s*([A-Za-z][A-Za-z ]{2,40}?)(?:\n|$)/i.exec(
			text,
		)?.[1];
	const order: ParsedOrder = {
		externalOrderId: id,
		merchantName: supplier ? cleanText(supplier) : undefined,
		orderUrl: input.pageUrl,
		orderDate: dateFromText(flat),
		statusText,
		status: buyerStatus(statusText),
		currency,
		totalMinor: total?.amountMinor,
		subtotalMinor:
			summaryMoney(/^item subtotal$/i)?.amountMinor ??
			moneyAfterLabel(
				text,
				/\b(?:product total|products? amount|subtotal|item total)\b\s*:?/i,
				opts,
			)?.amountMinor,
		shippingMinor:
			summaryMoney(/^shipping fee$/i)?.amountMinor ??
			moneyAfterLabel(
				text,
				/\b(?:shipping fee|shipping cost|shipping|freight|logistics fee)\b\s*:?/i,
				{ ...opts, allowFree: true },
			)?.amountMinor,
		taxMinor: moneyAfterLabel(
			text,
			/\b(?:tax(?:es)?|vat|gst|duties)\b\s*:?/i,
			opts,
		)?.amountMinor,
		discountMinor: moneyAfterLabel(
			text,
			/\b(?:discount|coupon|promotion)\b\s*:?/i,
			opts,
		)?.amountMinor,
		paymentLast4: extractLast4(flat),
		items: items.length ? items : undefined,
		documentLinks: documentLinks($, input.pageUrl),
	};
	return buildResult([order], [], "no Alibaba order data on page");
}

export const alibabaParser: StoreParser = {
	source: "alibaba",
	version: 3,
	parse(input) {
		return safeParse("alibaba", () => {
			const { payload } = input;
			if (payload.type === "json")
				return parseJson(input, payload.body, payload.requestUrl);
			if (payload.type === "html") return parseHtml(input, payload.html);
			return {
				outcome: "unsupported",
				reason: "page_text captures go to AI extraction",
			};
		});
	},
};
