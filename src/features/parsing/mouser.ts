/**
 * Mouser parser (HTML; ASP.NET WebForms).
 *
 * Detail (OrderHistory/OrderDetail / confirmation): server controls with
 * stable id *suffixes* (prefixes change): `[id$=lblSalesOrderNumber]`,
 * `[id$=lblWebOrderNumber]`, `[id$=lblOrderDateHeader]` ("14-Mar-26"),
 * `[id$=trOrderTotal]`, line grid `[id$=CartGrid_grid] tr[data-index]` with
 * `.td-qty`, `.td-price`, `a[id$=lnkMouserPartNumber]`,
 * `a[id$=lnkManufacturerPartNumber]`, `a[id$=lnkDescription]`,
 * `a[id$=lnkInvoice]` (WhatDidIBuy 2021, unverified against 2026 markup, so
 * every field has a label/table fallback).
 * History grid (`#tblOrders` / any table with Web Order #, Sales Order #,
 * Order Date, Status, Total columns) → one fragment per row.
 *
 * Order history JSON (`/api/OrderHistory/Orders`, a DataTables response):
 * `aaData[]` rows with WebOrderNumber / SalesOrderNumber, DateCreated (ISO),
 * `*Display` columns holding HTML fragments (status, order/invoice links,
 * tracking links) and `Invoices[]` (one per shipment: InvoiceTotal,
 * InvoiceSubTotal, CurrencyCode, TrackingNumberList). Order total = invoice
 * totals + OpenTotal; no line items in this response.
 *
 * Order identity: the Web Order # is shown on confirmation, history and
 * detail pages, while the Sales Order # appears only after processing; we key
 * orders by Web Order # when visible and fall back to Sales Order #.
 */
import { parseDate } from "./dates";
import { genericHtmlOrders } from "./generic";
import {
	absUrl,
	type Doc,
	documentLinks,
	findAll,
	linesOf,
	loadHtml,
	pickText,
	textOf,
} from "./html";
import {
	asArray,
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
	findTrackingNumbers,
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

function site(pageUrl: string): { origin: string; currency?: string } {
	try {
		const url = new URL(pageUrl);
		const host = url.hostname;
		const currency = /mouser\.ca$/.test(host)
			? "CAD"
			: /mouser\.co\.uk$/.test(host)
				? "GBP"
				: /mouser\.(de|fr|it|es|nl|at|be|ie|fi|pt|ee|lt|lv|sk|si|gr)$/.test(
							host,
						)
					? "EUR"
					: /mouser\.ch$/.test(host)
						? "CHF"
						: /mouser\.com$/.test(host)
							? "USD"
							: undefined;
		return { origin: url.origin, currency };
	} catch {
		return { origin: "https://www.mouser.com" };
	}
}

const WEB_ORDER_RE =
	/web\s*order\s*(?:#|number|no\.?|nummer)?\s*:?\s*(\d{6,12})/i;
const SALES_ORDER_RE =
	/sales\s*order\s*(?:#|number|no\.?|nummer)?\s*:?\s*(\d{6,12})/i;

function parseGridItems(
	$: Doc,
	origin: string,
	currency: string | undefined,
): ParsedItem[] {
	const items: ParsedItem[] = [];
	findAll(
		$,
		undefined,
		"[id$='CartGrid_grid'] tr[data-index], table[id$='CartGrid_grid'] tbody tr",
	).each((_, el) => {
		const row = $(el);
		const mouserPn =
			textOf(row.find("a[id$='lnkMouserPartNumber']").first()) || undefined;
		const mfrPn =
			textOf(row.find("a[id$='lnkManufacturerPartNumber']").first()) ||
			undefined;
		const descEl = row
			.find("a[id$='lnkDescription'], [id$='lblDescription']")
			.first();
		const title = textOf(descEl) || mfrPn || mouserPn;
		if (!title) return;
		const quantity =
			Number(
				/(\d[\d,]*)/
					.exec(textOf(row.find(".td-qty").first()))?.[1]
					?.replace(/,/g, "") ?? "1",
			) || 1;
		const unit = parseMoney(textOf(row.find(".td-price").first()), {
			currency,
		});
		const ext = parseMoney(
			textOf(row.find(".td-ext-price, .td-extended, .td-total").first()),
			{ currency },
		);
		const href = row
			.find("a[id$='lnkMouserPartNumber'], a[id$='lnkDescription']")
			.first()
			.attr("href");
		items.push({
			externalItemId: mouserPn,
			title,
			sku: mouserPn ?? mfrPn,
			variant: mfrPn && mfrPn !== title ? `MPN ${mfrPn}` : undefined,
			quantity,
			unitPriceMinor: unit?.amountMinor,
			totalMinor:
				ext?.amountMinor ?? (unit ? unit.amountMinor * quantity : undefined),
			itemUrl: absUrl(href, origin),
		});
	});
	// Rows can be duplicated by parse5 when both selectors match the same row.
	const seen = new Set<string>();
	return items.filter((i) => {
		const key = `${i.sku}|${i.title}|${i.quantity}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function parseDetail(
	$: Doc,
	input: ParserInput,
	warnings: string[],
): ParsedOrder[] {
	const { origin, currency: siteCurrency } = site(input.pageUrl);
	const body = $("body").length ? $("body") : $.root();
	const lines = linesOf(body);
	const text = lines.join("\n");
	const flat = cleanText(text);
	const webOrder =
		/(\d{6,12})/.exec(
			pickText($, undefined, [
				"[id$='lblWebOrderNumber']",
				"[id$='lblWebOrderNum']",
			]) ?? "",
		)?.[1] ?? WEB_ORDER_RE.exec(flat)?.[1];
	const salesOrder =
		/(\d{6,12})/.exec(
			pickText($, undefined, ["[id$='lblSalesOrderNumber']"]) ?? "",
		)?.[1] ?? SALES_ORDER_RE.exec(flat)?.[1];
	const id =
		webOrder ??
		salesOrder ??
		input.orderIdHints.find((h) => /^\d{6,12}$/.test(h));
	if (!id) return [];
	const currency = siteCurrency ?? parseMoney(flat)?.currency;
	const opts = { currency };
	let items = parseGridItems($, origin, currency);
	if (items.length === 0) items = tableItems($, undefined, origin, currency);
	const dateText =
		pickText($, undefined, [
			"[id$='lblOrderDateHeader']",
			"[id$='lblOrderDate']",
		]) ?? /order\s*date\s*:?\s*([^\n]{4,30})/i.exec(text)?.[1];
	const totalText = pickText($, undefined, [
		"[id$='trOrderTotal'] td:last-child",
		"[id$='lblOrderTotal']",
		"[id$='trOrderTotal']",
	]);
	const statusText =
		pickText($, undefined, ["[id$='lblOrderStatus']", "[id$='lblStatus']"]) ??
		/\border\s+status\s*:?\s*([A-Za-z][A-Za-z ]{2,30}?)(?:\n|$)/i.exec(
			text,
		)?.[1];
	const invoiceLinks = findAll($, undefined, "a[id$='lnkInvoice']")
		.toArray()
		.map((a) => absUrl($(a).attr("href"), origin))
		.filter((u): u is string => Boolean(u))
		.map((url) => ({ kind: "invoice" as const, url }));
	const order: ParsedOrder = {
		externalOrderId: id,
		merchantName: "Mouser Electronics",
		orderUrl: input.pageUrl,
		orderDate: parseDate(dateText, { dayFirst: true }),
		statusText,
		status: normalizeStatus(statusText),
		currency,
		subtotalMinor: moneyAfterLabel(
			text,
			/\b(?:merchandise(?:\s+total)?|subtotal)\b\s*:?/i,
			opts,
		)?.amountMinor,
		shippingMinor: moneyAfterLabel(
			text,
			/\b(?:shipping|freight)(?:\s*(?:&|and)\s*handling)?\b\s*:?/i,
			{ ...opts, allowFree: true },
		)?.amountMinor,
		taxMinor: moneyAfterLabel(
			text,
			/\b(?:sales\s+tax|tax|vat|gst|hst)\b\s*:?/i,
			opts,
		)?.amountMinor,
		totalMinor:
			(totalText ? parseMoney(totalText, opts)?.amountMinor : undefined) ??
			moneyAfterLabel(text, /\b(?:order total|grand total)\b\s*:?/i, {
				...opts,
				last: true,
			})?.amountMinor,
		paymentLast4: extractLast4(flat),
		items: items.length ? items : undefined,
		documentLinks: [...invoiceLinks, ...documentLinks($, origin)],
	};
	if (!items.length) warnings.push("mouser: no line items recognized");
	return [order];
}

/** Order history grid: one fragment per row, keyed by Web Order #. */
function parseHistory($: Doc, input: ParserInput): ParsedOrder[] {
	const { origin, currency } = site(input.pageUrl);
	const orders: ParsedOrder[] = [];
	findAll($, undefined, "table").each((_, tableEl) => {
		const table = $(tableEl);
		const headers = (
			table.find("thead tr").first().length
				? table.find("thead tr").first()
				: table.find("tr").first()
		)
			.find("th, td")
			.toArray()
			.map((c) => textOf($(c)).toLowerCase());
		const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
		const webCol = col(/web\s*order/);
		const soCol = col(/sales\s*order/);
		if (webCol < 0 && soCol < 0) return;
		const dateCol = col(/date/);
		const statusCol = col(/status/);
		const totalCol = col(/total|amount/);
		table.find("tbody tr").each((_, rowEl) => {
			const cells = $(rowEl).find("td");
			if (cells.length < 2) return;
			const cellText = (i: number) => (i >= 0 ? textOf(cells.eq(i)) : "");
			const web = /(\d{6,12})/.exec(cellText(webCol))?.[1];
			const so = /(\d{6,12})/.exec(cellText(soCol))?.[1];
			const id = web ?? so;
			if (!id) return;
			const link = cells.find("a[href]").first();
			const statusText = cellText(statusCol) || undefined;
			const total = parseMoney(cellText(totalCol), { currency });
			orders.push({
				externalOrderId: id,
				merchantName: "Mouser Electronics",
				orderUrl: absUrl(link.attr("href"), origin),
				orderDate: parseDate(cellText(dateCol), { dayFirst: true }),
				statusText,
				status: normalizeStatus(statusText),
				currency: total?.currency ?? currency,
				totalMinor: total?.amountMinor,
			});
		});
	});
	return orders;
}

function parseHtml(input: ParserInput, html: string): ParseResult {
	const warnings: string[] = [];
	const $ = loadHtml(html);
	if (/access to this page has been denied/i.test(textOf($("body"))))
		return { outcome: "no_orders", reason: "Mouser bot challenge page" };
	const isHistory =
		input.pageType === "order_list" ||
		(/OrdersView|OrderHistory\/?$|orderhistory/i.test(input.pageUrl) &&
			!/detail/i.test(input.pageUrl));
	let orders = isHistory
		? parseHistory($, input)
		: parseDetail($, input, warnings);
	if (orders.length === 0)
		orders = isHistory
			? parseDetail($, input, warnings)
			: parseHistory($, input);
	if (orders.length === 0) {
		const fallback = genericHtmlOrders($, input, {
			currencyHint: site(input.pageUrl).currency,
		});
		orders = fallback.orders;
		warnings.push(...fallback.warnings);
	}
	if (queryParam(input.pageUrl, "qs") && orders.length === 1 && orders[0])
		orders[0].orderUrl = input.pageUrl;
	return buildResult(orders, warnings, "no Mouser orders found on page");
}

/** `href` values of the anchors in a Display column (HTML fragment). */
function hrefsIn(fragment: string | undefined, origin: string): string[] {
	if (!fragment) return [];
	return [...fragment.matchAll(/href\s*=\s*(["'])(.*?)\1/gi)]
		.map((m) => absUrl(m[2]?.replace(/&amp;/g, "&"), origin))
		.filter((u): u is string => Boolean(u));
}

/** Tag-stripped text of a Display column ("<div>Complete<br /></div>"). */
function displayText(fragment: unknown): string | undefined {
	const value = str(fragment);
	if (!value) return undefined;
	return (
		cleanText(value.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")) ||
		undefined
	);
}

function isoDate(value: unknown): string | undefined {
	return /^(\d{4}-\d{2}-\d{2})T/.exec(str(value) ?? "")?.[1];
}

/** One `aaData` row of `/api/OrderHistory/Orders` → order fragment. */
function jsonOrder(
	row: JsonRecord,
	origin: string,
	siteCurrency: string | undefined,
): ParsedOrder | undefined {
	const id =
		/^\d{6,12}$/.exec(str(row.WebOrderNumber) ?? "")?.[0] ??
		/^\d{6,12}$/.exec(str(row.SalesOrderNumber) ?? "")?.[0];
	if (!id) return undefined;
	const invoices = records(row.Invoices);
	const currency =
		normalizeCurrencyCode(str(row.CurrencyCode)) ??
		invoices
			.map((inv) => normalizeCurrencyCode(str(inv.CurrencyCode)))
			.find(Boolean) ??
		siteCurrency ??
		parseMoney(displayText(row.InvoiceTotalDisplay) ?? "")?.currency;
	// Invoices are per shipment; the open total covers unshipped lines.
	const minor = (value: unknown) => {
		const n = num(value);
		return n === undefined ? undefined : toMinor(n, currency);
	};
	const sum = (values: Array<number | undefined>) =>
		values.length && values.every((v) => v !== undefined)
			? values.reduce<number>((a, v) => a + (v ?? 0), 0)
			: undefined;
	const open = minor(row.OpenTotal) ?? 0;
	const invoiced = sum(invoices.map((inv) => minor(inv.InvoiceTotal)));
	const totalMinor =
		invoiced !== undefined ? invoiced + open : open > 0 ? open : undefined;
	const subtotalMinor =
		open === 0
			? sum(invoices.map((inv) => minor(inv.InvoiceSubTotal)))
			: undefined;
	const shipments: ParsedShipment[] = [];
	const seen = new Set<string>();
	for (const inv of invoices) {
		const display = str(inv.TrackingNumbersDisplay);
		for (const value of asArray(inv.TrackingNumberList)) {
			const trackingNumber = str(value);
			if (!trackingNumber || seen.has(trackingNumber)) continue;
			seen.add(trackingNumber);
			shipments.push({
				trackingNumber,
				carrier:
					findTrackingNumbers(trackingNumber)[0]?.carrier ??
					detectCarrier(display),
			});
		}
	}
	if (shipments.length === 0)
		for (const hit of findTrackingNumbers(
			displayText(row.TrackingNumbersDisplay) ?? "",
		))
			shipments.push(hit);
	const invoiceHtml = [
		str(row.InvoiceNumberDisplay),
		...invoices.map((inv) => str(inv.InvoiceNumberDisplay)),
	];
	const documentLinks = [
		...new Set(invoiceHtml.flatMap((html) => hrefsIn(html, origin))),
	].map((url) => ({ kind: "invoice" as const, url }));
	const statusText = displayText(row.OrderStatusDisplay);
	return {
		externalOrderId: id,
		merchantName: "Mouser Electronics",
		orderUrl: hrefsIn(
			str(row.WebOrderNumberDisplay) ?? str(row.SalesOrderNumberDisplay),
			origin,
		)[0],
		orderDate:
			isoDate(row.DateCreated) ??
			parseDate(str(row.SalesOrderDateDisplay), { dayFirst: true }),
		statusText,
		status: normalizeStatus(statusText),
		currency,
		subtotalMinor,
		totalMinor,
		shipments: shipments.length ? shipments : undefined,
		documentLinks: documentLinks.length ? documentLinks : undefined,
	};
}

function parseJson(input: ParserInput, requestUrl: string, body: unknown) {
	const data = unwrapBody(body);
	const rows = isRecord(data) ? records(data.aaData) : [];
	const ordersApi = /\/api\/OrderHistory\/Orders\b/i.test(requestUrl);
	if (rows.length === 0) {
		if (ordersApi)
			return {
				outcome: "no_orders" as const,
				reason: "empty Mouser order history page",
			};
		if (/mouser\.[a-z.]+\/api\//i.test(requestUrl))
			return {
				outcome: "no_orders" as const,
				reason: "Mouser API response without order data",
			};
		return {
			outcome: "no_orders" as const,
			reason: "Mouser JSON not recognized as order history",
		};
	}
	const { origin, currency } = site(input.pageUrl);
	const orders = rows
		.map((row) => jsonOrder(row, origin, currency))
		.filter((o): o is ParsedOrder => Boolean(o));
	return buildResult(orders, [], "no Mouser orders in order history JSON");
}

export const mouserParser: StoreParser = {
	source: "mouser",
	version: 2,
	parse(input) {
		return safeParse("mouser", () => {
			const { payload } = input;
			if (payload.type === "html") return parseHtml(input, payload.html);
			if (payload.type === "json")
				return parseJson(input, payload.requestUrl, payload.body);
			return {
				outcome: "unsupported",
				reason: "page_text captures go to AI extraction",
			};
		});
	},
};
