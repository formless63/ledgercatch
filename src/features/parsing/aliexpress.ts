/**
 * AliExpress parser.
 *
 * JSON (primary): MTOP "Ultron" component graphs captured from
 *   - mtop.aliexpress.trade.buyer.order.list   → `pc_om_list_order_<id>` components
 *   - mtop.aliexpress.trade.buyer.order.detail → `detail_*` components by `tag`
 *   - mtop.ae.ld.querydetail                   → tracking packages
 * Components live at `data.data[<key>] = { tag, id, fields }`; keys carry CMS
 * suffixes, so we select by tag / key prefix only.
 *
 * HTML (fallback): rendered /p/order/index.html and /p/order/detail.html DOM
 * (`.order-item`, `.order-item-header-right-info`, `.order-price-item`,
 * `.order-detail-item-content-wrap` …).
 */
import { parseDate } from "./dates";
import { genericHtmlOrders } from "./generic";
import {
	absUrl,
	type Doc,
	documentLinks,
	findAll,
	imageUrl,
	linesOf,
	loadHtml,
	pick,
	pickText,
	textOf,
} from "./html";
import {
	findRecords,
	getPath,
	isRecord,
	type JsonRecord,
	num,
	queryParam,
	records,
	str,
	unwrapBody,
} from "./json";
import { minorDigits, normalizeCurrencyCode, parseMoney } from "./money";
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

const ORDER_ID_RE = /\b\d{12,20}\b/;
const DETAIL_URL = "https://www.aliexpress.com/p/order/detail.html?orderId=";

/** "R$126,59|126|59" → minor units (int part + cents). */
export function formatPriceInfoToMinor(
	info: unknown,
	currency: string | undefined,
): number | undefined {
	const text = str(info);
	if (!text) return undefined;
	const parts = text.split("|");
	if (parts.length < 3) return undefined;
	const intPart = Number(String(parts[1]).replace(/[^\d-]/g, ""));
	const centsText = String(parts[2]).replace(/\D/g, "");
	if (!Number.isFinite(intPart) || parts[1] === "") return undefined;
	const digits = minorDigits(currency);
	if (digits === 0) return intPart;
	const cents = centsText
		? Number(centsText.padEnd(digits, "0").slice(0, digits))
		: 0;
	return intPart * 10 ** digits + (intPart < 0 ? -cents : cents);
}

function priceMinor(
	formatPriceInfo: unknown,
	text: unknown,
	currency: string | undefined,
): { minor?: number; currency?: string } {
	const fromInfo = formatPriceInfoToMinor(formatPriceInfo, currency);
	const display = str(text) ?? str(formatPriceInfo)?.split("|")[0];
	const parsed = display ? parseMoney(display, { currency }) : undefined;
	return {
		minor: fromInfo ?? parsed?.amountMinor,
		currency: currency ?? parsed?.currency,
	};
}

function skuVariant(skuAttrs: unknown): string | undefined {
	const parts = records(skuAttrs)
		.map((a) => {
			const name = str(a.name);
			const text = str(a.text) ?? str(a.value);
			return name && text ? `${name}: ${text}` : text;
		})
		.filter(Boolean);
	if (parts.length) return parts.join(", ");
	return str(skuAttrs);
}

function httpsUrl(value: unknown): string | undefined {
	const s = str(value);
	if (!s) return undefined;
	return absUrl(s, "https://www.aliexpress.com/");
}

function lineToItem(
	line: JsonRecord,
	currency: string | undefined,
): ParsedItem {
	const quantity = num(line.quantity) ?? num(line.count) ?? 1;
	const lineCurrency =
		normalizeCurrencyCode(str(line.currencyCode)) ?? currency;
	const unit = priceMinor(
		line.formatPriceInfo,
		line.itemPriceText ?? line.price,
		lineCurrency,
	);
	return {
		externalItemId: str(line.orderLineId) ?? str(line.tradeOrderLineId),
		title:
			str(line.itemTitle) ?? str(line.productName) ?? str(line.title) ?? "",
		sku: str(line.skuId) ?? str(line.productId),
		variant: skuVariant(line.skuAttrs) ?? str(line.skuDesc),
		quantity,
		unitPriceMinor: unit.minor,
		totalMinor: unit.minor === undefined ? undefined : unit.minor * quantity,
		imageUrl: httpsUrl(line.itemImgUrl ?? line.itemPic ?? line.imgUrl),
		itemUrl: httpsUrl(line.itemDetailUrl ?? line.productDetailUrl),
	};
}

/** Finds the component map (`data.data`) inside an MTOP envelope. */
function componentMap(body: unknown): JsonRecord | undefined {
	const looksLikeComponents = (r: JsonRecord) =>
		Object.entries(r).some(
			([key, v]) =>
				isRecord(v) &&
				isRecord(v.fields) &&
				(key.startsWith("pc_om_list_") ||
					key.startsWith("detail_") ||
					typeof v.tag === "string"),
		);
	for (const path of ["data.data", "data", "response.data.data", ""]) {
		const candidate = path ? getPath(body, path) : body;
		if (isRecord(candidate) && looksLikeComponents(candidate)) return candidate;
	}
	return findRecords(body, looksLikeComponents, { maxDepth: 6, limit: 1 })[0];
}

function componentsByTag(map: JsonRecord, tag: string): JsonRecord[] {
	return Object.entries(map)
		.filter(
			([key, v]) =>
				isRecord(v) &&
				(v.tag === tag ||
					key === tag ||
					key.startsWith(`${tag}_`) ||
					key.startsWith(`${tag}-`)),
		)
		.map(([, v]) => v as JsonRecord);
}

function fieldsOf(component: JsonRecord | undefined): JsonRecord {
	return component && isRecord(component.fields) ? component.fields : {};
}

/** The MTOP GET `data=` param (JSON) often carries the tradeOrderId. */
function idFromRequestUrl(url: string | undefined): string | undefined {
	const data = queryParam(url, "data");
	if (data) {
		const m = /"(?:tradeOrderId|orderId)"\s*:\s*"?(\d{12,20})/.exec(data);
		if (m) return m[1];
	}
	return queryParam(url, "tradeOrderId") ?? queryParam(url, "orderId");
}

/**
 * Resolves the order id for a detail/tracking response. Numeric ids above
 * 2^53 lose precision in JSON.parse, so prefer strings from URLs/hints and
 * only use a numeric field when it is safe or matches a hint.
 */
function resolveOrderId(
	candidates: unknown[],
	input: ParserInput,
	requestUrl: string | undefined,
	warnings: string[],
): string | undefined {
	const external = [
		idFromRequestUrl(requestUrl),
		queryParam(input.pageUrl, "orderId"),
		queryParam(input.pageUrl, "tradeOrderId"),
		...input.orderIdHints,
	].filter((v): v is string => Boolean(v && ORDER_ID_RE.test(v)));
	for (const c of candidates) {
		if (typeof c === "string" && ORDER_ID_RE.test(c)) return c;
		if (typeof c === "number" && Number.isFinite(c)) {
			if (Number.isSafeInteger(c)) return String(c);
			const match = external.find((e) => Number(e) === c);
			if (match) return match;
			warnings.push(
				"aliexpress: numeric order id exceeds 2^53; using URL/hint id",
			);
		}
	}
	return external[0];
}

function parseList(map: JsonRecord, warnings: string[]): ParsedOrder[] {
	const orders: ParsedOrder[] = [];
	for (const [key, comp] of Object.entries(map)) {
		if (!isRecord(comp)) continue;
		const isOrder =
			key.startsWith("pc_om_list_order_") || comp.tag === "pc_om_list_order";
		if (!isOrder) continue;
		const f = fieldsOf(comp);
		const id =
			str(f.orderId) ?? str(comp.id) ?? key.replace(/^pc_om_list_order_/, "");
		if (!id || !/^\d+$/.test(id)) {
			warnings.push(`aliexpress: list component ${key} has no order id`);
			continue;
		}
		const lines = records(f.orderLines);
		const currency =
			normalizeCurrencyCode(str(f.currencyCode)) ??
			normalizeCurrencyCode(str(lines[0]?.currencyCode)) ??
			parseMoney(str(f.totalPriceText))?.currency;
		const total = priceMinor(f.formatPriceInfo, f.totalPriceText, currency);
		const items = lines.map((l) => lineToItem(l, currency));
		orders.push({
			externalOrderId: id,
			merchantName: str(f.storeName),
			orderUrl: httpsUrl(f.orderDetailUrl) ?? `${DETAIL_URL}${id}`,
			orderDate: parseDate(str(f.orderDateText)),
			statusText: str(f.statusText),
			status: normalizeStatus(str(f.statusText)),
			currency: currency ?? total.currency,
			totalMinor: total.minor,
			items,
			// The list shows every line of the order today, but it is a summary
			// view; let the detail page win when it is captured.
			itemsPartial: true,
		});
	}
	return orders;
}

const PRICE_ROW_RULES: Array<
	[RegExp, "subtotalMinor" | "shippingMinor" | "taxMinor" | "discountMinor"]
> = [
	[
		/discount|coupon|promo|saved|savings|voucher|rabatt|off\b|bonus|coins/i,
		"discountMinor",
	],
	[/shipping|delivery|postage|freight|versand|frete|envío/i, "shippingMinor"],
	[/\btax|vat|gst|iva|mwst|duties|import charges/i, "taxMinor"],
	[
		/subtotal|items? total|product total|item\(s\)|merchandise|zwischensumme|^items?$|^products?$/i,
		"subtotalMinor",
	],
];

function applyPriceRows(
	order: ParsedOrder,
	rows: Array<{ title: string; value: string }>,
	currency: string | undefined,
) {
	for (const row of rows) {
		if (
			/^total\b|order total|grand total|total amount|gesamt/i.test(row.title) &&
			!/sub/i.test(row.title)
		) {
			const total = parseMoney(row.value, { currency });
			if (total && order.totalMinor === undefined)
				order.totalMinor = total.amountMinor;
			continue;
		}
		const rule = PRICE_ROW_RULES.find(([re]) => re.test(row.title));
		if (!rule) continue;
		const money = parseMoney(row.value, { currency, allowFree: true });
		if (!money) continue;
		const field = rule[1];
		const value =
			field === "discountMinor"
				? Math.abs(money.amountMinor)
				: money.amountMinor;
		order[field] =
			(field === "subtotalMinor" ? 0 : (order[field] ?? 0)) + value;
		order.currency = order.currency ?? money.currency;
	}
}

function parseDetail(
	map: JsonRecord,
	input: ParserInput,
	requestUrl: string | undefined,
	warnings: string[],
): ParsedOrder[] {
	const info = fieldsOf(
		componentsByTag(map, "detail_simple_order_info_component")[0],
	);
	const priceBlock = fieldsOf(
		componentsByTag(map, "detail_order_price_block")[0],
	);
	const statusBlock = fieldsOf(
		componentsByTag(map, "detail_order_status_block")[0],
	);
	const productBlocks = componentsByTag(map, "detail_product_block").map(
		fieldsOf,
	);
	const anyFields = Object.values(map)
		.filter(isRecord)
		.map((c) => fieldsOf(c));
	const id = resolveOrderId(
		[
			info.tradeOrderId,
			info.orderId,
			...anyFields.map((f) => f.tradeOrderId ?? f.orderId),
		],
		input,
		requestUrl,
		warnings,
	);
	if (!id) {
		warnings.push("aliexpress: detail response without an order id");
		return [];
	}
	const totalPrice = isRecord(priceBlock.totalPrice)
		? priceBlock.totalPrice
		: {};
	const currency =
		normalizeCurrencyCode(str(totalPrice.currencyCode)) ??
		normalizeCurrencyCode(str(priceBlock.currencyCode)) ??
		normalizeCurrencyCode(
			str(records(productBlocks[0]?.productVOList)[0]?.currencyCode),
		);
	const total = priceMinor(
		totalPrice.formatPriceInfo,
		totalPrice.value ?? totalPrice.text,
		currency,
	);
	const items: ParsedItem[] = [];
	let merchant: string | undefined;
	for (const block of productBlocks) {
		for (const line of records(block.productVOList))
			items.push(lineToItem(line, currency ?? total.currency));
		const seller = isRecord(block.sellerVO) ? block.sellerVO : {};
		merchant = merchant ?? str(seller.sellerName) ?? str(seller.storeName);
	}
	const paymentMethod = str(info.paymentMethod);
	const statusText = str(statusBlock.title) ?? str(statusBlock.statusText);
	const docs: ParsedOrder["documentLinks"] = [];
	for (const button of records(statusBlock.buttonVOList)) {
		if (
			str(button.type) === "DOWNLOAD_INVOICE" ||
			/invoice/i.test(str(button.text) ?? "")
		) {
			const href = httpsUrl(button.href ?? button.url);
			if (href) docs.push({ kind: "invoice", url: href });
		}
	}
	const order: ParsedOrder = {
		externalOrderId: id,
		merchantName: merchant,
		orderUrl: `${DETAIL_URL}${id}`,
		orderDate: parseDate(
			str(info.orderCreatTime) ??
				str(info.orderCreateTime) ??
				num(info.gmtCreate),
		),
		statusText,
		status: normalizeStatus(statusText),
		currency: currency ?? total.currency,
		totalMinor: total.minor,
		paymentHint: paymentMethod,
		paymentLast4: extractLast4(paymentMethod),
		items: items.length ? items : undefined,
		itemsPartial: items.length ? false : undefined,
		documentLinks: docs,
	};
	const rows = records(priceBlock.priceDetails).map((r) => ({
		title: str(r.title) ?? str(r.name) ?? "",
		value: str(r.value) ?? str(r.content) ?? "",
	}));
	applyPriceRows(order, rows, order.currency);
	return [order];
}

function parseTracking(
	body: unknown,
	input: ParserInput,
	requestUrl: string | undefined,
	warnings: string[],
): ParsedOrder[] {
	const module =
		getPath(body, "data.module") ??
		getPath(body, "module") ??
		getPath(body, "data.data.module");
	const lines = records(
		isRecord(module) ? module.trackingDetailLineList : undefined,
	);
	if (!lines.length) return [];
	const id = resolveOrderId(
		[
			isRecord(module) ? module.tradeOrderId : undefined,
			...lines.map((l) => l.tradeOrderId),
		],
		input,
		requestUrl,
		warnings,
	);
	if (!id) {
		warnings.push("aliexpress: tracking response without an order id");
		return [];
	}
	const shipments: ParsedShipment[] = [];
	let allDelivered = true;
	for (const line of lines) {
		const tracking = str(line.mailNo) ?? str(line.originMailNo);
		if (!tracking) continue;
		const events = records(line.detailList);
		const delivered = events.some(
			(e) => str(e.trackingPrimaryCode) === "AE_GTMS_SIGNED",
		);
		if (!delivered) allDelivered = false;
		const latest = events[0];
		const cp = isRecord(line.logisticsCpInfo) ? line.logisticsCpInfo : {};
		const eta = isRecord(line.etaInfo) ? line.etaInfo : {};
		shipments.push({
			trackingNumber: tracking,
			carrier: str(line.logisticsCarrierName) ?? str(cp.cpName),
			status:
				str(latest?.standerdDesc) ??
				str(latest?.desc) ??
				str(latest?.trackingSecondaryCode),
			deliveredAt: delivered
				? parseDate(
						num(
							events.find(
								(e) => str(e.trackingPrimaryCode) === "AE_GTMS_SIGNED",
							)?.time,
						),
					)
				: undefined,
			etaText: str(eta.etaTimeText),
		});
	}
	if (!shipments.length) return [];
	return [
		{
			externalOrderId: id,
			shipments,
			status: allDelivered ? "delivered" : "shipped",
		},
	];
}

function parseJson(
	input: ParserInput,
	body: unknown,
	requestUrl: string,
): ParseResult {
	const warnings: string[] = [];
	const data = unwrapBody(body);
	const ret = getPath(data, "ret");
	if (
		Array.isArray(ret) &&
		typeof ret[0] === "string" &&
		!ret[0].startsWith("SUCCESS")
	)
		return { outcome: "no_orders", reason: `MTOP error: ${ret[0]}` };
	const orders: ParsedOrder[] = [];
	if (/querydetail|logistic|tracking/i.test(requestUrl)) {
		orders.push(...parseTracking(data, input, requestUrl, warnings));
	} else {
		const map = componentMap(data);
		if (map) {
			const hasList = Object.keys(map).some((k) =>
				k.startsWith("pc_om_list_order_"),
			);
			if (hasList || /order\.list/i.test(requestUrl))
				orders.push(...parseList(map, warnings));
			if (!hasList)
				orders.push(...parseDetail(map, input, requestUrl, warnings));
		} else {
			orders.push(...parseTracking(data, input, requestUrl, warnings));
		}
	}
	return buildResult(
		orders,
		warnings,
		"no AliExpress orders in response (empty page or unrelated API)",
	);
}

/* -------------------------------- HTML ---------------------------------- */

/**
 * Text of a price element. AliExpress renders amounts one character per
 * `<span class="es--char">`, which `textOf` spaces out ("$ 4 . 5 9"); close
 * the gaps between currency/number characters so "$4.59" parses whole.
 */
function moneyText(sel: Parameters<typeof textOf>[0]): string {
	return textOf(sel).replace(/(?<=[\d.,$€£¥])\s+(?=[\d.,])/g, "");
}

function labeledValue(lines: string[], label: RegExp): string | undefined {
	for (const line of lines) {
		const m = label.exec(line);
		if (m)
			return (
				cleanText(
					line.slice((m.index ?? 0) + m[0].length).replace(/^[\s:：]+/, ""),
				) || undefined
			);
	}
	return undefined;
}

function parseListHtml($: Doc, input: ParserInput): ParsedOrder[] {
	const orders: ParsedOrder[] = [];
	findAll($, undefined, ".order-item").each((_, el) => {
		const card = $(el);
		const infoLines = linesOf(
			card.find(".order-item-header-right-info, .order-item-header-right"),
		);
		const id =
			labeledValue(
				infoLines,
				/(?:order\s*(?:id|number|no\.?)|ref\.?\s*number)\s*[:：]?/i,
			)?.match(/\d{12,20}/)?.[0] ??
			card
				.find('a[href*="orderId="]')
				.first()
				.attr("href")
				?.match(/orderId=(\d+)/)?.[1];
		if (!id) return;
		const dateText = labeledValue(infoLines, /(?:order\s*)?date\s*[:：]?/i);
		const statusText = pickText($, card, [
			".order-item-header-status-text",
			".order-item-header-status",
		]);
		const totalText = moneyText(
			pick($, card, [
				".order-item-content-opt-price-total",
				".order-item-content-opt-price",
			])?.first(),
		);
		const total = totalText ? parseMoney(totalText) : undefined;
		const items: ParsedItem[] = [];
		let rows = findAll($, card, ".order-item-content-body");
		if (rows.length === 0) rows = findAll($, card, ".order-item-content");
		rows.each((_, itemEl) => {
			const row = $(itemEl);
			const link = row.find(".order-item-content-info-name a").first();
			const title = textOf(
				link.length ? link : row.find(".order-item-content-info-name").first(),
			);
			if (!title) return;
			const qtyText = textOf(
				row
					.find(
						".order-item-content-info-number-quantity, .order-item-content-info-number",
					)
					.first(),
			);
			const quantity = Number(/[x×]\s*(\d+)/i.exec(qtyText)?.[1] ?? "1");
			const priceText = moneyText(
				row.find(".order-item-content-info-number").first(),
			).replace(/[x×]\s*\d+\s*$/i, "");
			const unit = parseMoney(priceText, { currency: total?.currency });
			const bg = row.find(".order-item-content-img").attr("style") ?? "";
			items.push({
				title,
				quantity,
				variant:
					textOf(row.find(".order-item-content-info-sku").first()) || undefined,
				unitPriceMinor: unit?.amountMinor,
				totalMinor: unit ? unit.amountMinor * quantity : undefined,
				itemUrl: absUrl(link.attr("href"), input.pageUrl),
				imageUrl: absUrl(/url\(["']?([^"')]+)/.exec(bg)?.[1], input.pageUrl),
			});
		});
		orders.push({
			externalOrderId: id,
			merchantName: pickText($, card, [
				".order-item-store-name a span",
				".order-item-store-name",
			]),
			orderUrl: `${DETAIL_URL}${id}`,
			orderDate: parseDate(dateText),
			statusText,
			status: normalizeStatus(statusText),
			currency: total?.currency,
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
	const lines = linesOf(
		$(".order-detail-info-item, .info-row, .order-detail-order-info"),
	);
	const id =
		labeledValue(lines, /order\s*(id|number|no\.?)\s*[:：]?/i)?.match(
			/\d{12,20}/,
		)?.[0] ??
		queryParam(input.pageUrl, "orderId") ??
		(input.orderIdHints.length === 1 ? input.orderIdHints[0] : undefined);
	if (!id) return [];
	const rows: Array<{ title: string; value: string }> = [];
	findAll($, undefined, ".order-price-item").each((_, el) => {
		const row = $(el);
		rows.push({
			title: textOf(row.find(".left-col").first()),
			value: moneyText(row.find(".right-col").first()),
		});
	});
	const totalRow = rows.find((r) => /^total/i.test(r.title));
	const currency = parseMoney(totalRow?.value ?? rows[0]?.value)?.currency;
	const items: ParsedItem[] = [];
	findAll($, undefined, ".order-detail-item-content-wrap").each((_, el) => {
		const row = $(el);
		const titleEl = row.find(".item-title").first();
		const link = titleEl.find("a").first();
		const title = textOf(titleEl);
		if (!title) return;
		const priceCount = moneyText(row.find(".item-price").first());
		const quantity = Number(/[x×]\s*(\d+)\s*$/i.exec(priceCount)?.[1] ?? "1");
		const unit = parseMoney(priceCount.replace(/[x×]\s*\d+\s*$/i, ""), {
			currency,
		});
		const href = link.attr("href");
		items.push({
			title,
			sku: /item\/(\d+)\.html/.exec(href ?? "")?.[1],
			variant: textOf(row.find(".item-sku-attr").first()) || undefined,
			quantity,
			unitPriceMinor: unit?.amountMinor,
			totalMinor: unit ? unit.amountMinor * quantity : undefined,
			itemUrl: absUrl(href, input.pageUrl),
			imageUrl: imageUrl(row.find("img"), input.pageUrl),
		});
	});
	const payment = labeledValue(lines, /^payment(\s*method)?\s*[:：]?/i);
	const statusText = pickText($, undefined, [
		".order-block-title",
		".order-status .order-block-title",
		".order-detail-status-title",
		".status-title-text",
	]);
	const order: ParsedOrder = {
		externalOrderId: id,
		orderUrl: `${DETAIL_URL}${id}`,
		orderDate: parseDate(
			labeledValue(lines, /order\s*(date|time|placed)\s*[:：]?/i),
		),
		statusText,
		status: normalizeStatus(statusText),
		merchantName: pickText($, undefined, [
			".store-name",
			".order-detail-item-store a",
			".order-detail-item-store",
		]),
		paymentHint: payment,
		paymentLast4: extractLast4(payment),
		currency,
		items: items.length ? items : undefined,
		itemsPartial: items.length ? false : undefined,
		documentLinks: documentLinks($, input.pageUrl),
	};
	applyPriceRows(order, rows, currency);
	if (!items.length) warnings.push("aliexpress: detail page without item rows");
	return [order];
}

function parseHtml(input: ParserInput, html: string): ParseResult {
	const warnings: string[] = [];
	const $ = loadHtml(html);
	const isDetail =
		input.pageType === "order_detail" ||
		/\/order\/detail/i.test(input.pageUrl) ||
		$(".order-detail-item-content-wrap").length > 0;
	const orders = isDetail
		? parseDetailHtml($, input, warnings)
		: parseListHtml($, input);
	if (orders.length === 0) {
		const fallback = genericHtmlOrders($, input, { allowText: false });
		orders.push(
			...fallback.orders.map((o) => ({ ...o, merchantName: o.merchantName })),
		);
	}
	// Tracking page: /p/tracking/index.html?tradeOrderId=
	if (orders.length === 0 && /tracking/i.test(input.pageUrl)) {
		const id = queryParam(input.pageUrl, "tradeOrderId");
		const number = pickText($, undefined, [
			".tracking-no",
			".logistic-info-no",
			".title-eclp",
		]);
		const tracking = number?.match(/[A-Z0-9]{8,30}/)?.[0];
		if (id && tracking)
			orders.push({
				externalOrderId: id,
				shipments: [
					{ trackingNumber: tracking, carrier: detectCarrier(number) },
				],
			});
	}
	return buildResult(
		orders,
		warnings,
		"no AliExpress order cards found in page",
	);
}

export const aliexpressParser: StoreParser = {
	source: "aliexpress",
	version: 2,
	parse(input) {
		return safeParse("aliexpress", () => {
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
