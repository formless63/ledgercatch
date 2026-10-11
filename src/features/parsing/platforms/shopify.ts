/**
 * Shopify order pages.
 *
 * - Classic customer account order page (`/account/orders/<token>`), from
 *   Dawn's `sections/main-order.liquid` (v15.x; the same table is used by
 *   most Online Store 2.0 themes): `table.order-details` with
 *   `th#ColumnProduct/ColumnSku/ColumnPrice/ColumnQuantity/ColumnTotal`,
 *   body cells addressed by `headers="Row<key> Column…"`, tfoot cells
 *   `td#RowSubtotal/RowDiscount/RowShipping/RowTax/RowDuties/RowTotal`, the
 *   order name in the table caption ("Order #1001") and the placed date as
 *   `<time datetime>`.
 * - Legacy `checkout.liquid` thank-you / order status pages with the
 *   `Shopify.checkout = {…}` global (order_id, line_items, subtotal_price,
 *   total_tax, shipping_rate, total_price, currency). Shopify retired these
 *   pages for all shops by Aug 2026, but old captures still re-parse. The
 *   visible order name comes from `.os-order-number` ("Order #1001"); the
 *   global only has the internal numeric `order_id`, used as a last resort.
 *
 * Not handled here (obfuscated React markup, no stable hooks): the
 * checkout-extensibility thank-you page (`/checkouts/c/<token>/thank-you`,
 * shows "Confirmation #XXXX") and new customer accounts
 * (`shopify.com/<shop>/account/orders/<id>`). Those fall through to the
 * generic text heuristics / AI extraction.
 */
import { parseDate } from "../dates";
import { absUrl, type Doc, imageUrl, type Sel, textOf } from "../html";
import {
	balancedObjectAt,
	isRecord,
	num,
	parseLooseJson,
	records,
	str,
} from "../json";
import { normalizeCurrencyCode, toMinor } from "../money";
import { cleanText, findTrackingNumbers } from "../text";
import type { ParsedItem, ParsedOrder, ParsedShipment } from "../types";
import {
	cleanOrderNumber,
	currencyFromHtml,
	defined,
	foldTotals,
	minorOf,
	quantityOf,
} from "./shared";
import type { Platform, PlatformContext } from "./types";

const SHOPIFY_RE =
	/Shopify\.(?:shop|checkout|theme|routes)\s*=|cdn\.shopify\.com|\/cdn\/shop\/|\/\/[\w-]+\.myshopify\.com|shopify-checkout-api-token|shopify-digital-wallet|class="shopify-section\b/i;
const ORDER_URL_RE =
	/\/account\/orders\/[\w-]+|\/\d+\/orders\/[0-9a-f]{16,}|\/checkouts\/[\w/]*thank[-_]?you/i;

/** "Order #1001" / "Commande n° #SH-1001" → "SH-1001" (no leading #). */
function orderName(text: string): string | undefined {
	const hash = /#\s*([A-Za-z0-9][\w-]*)/.exec(text);
	if (hash?.[1]) return hash[1];
	const last = /([A-Za-z]*\d[\w-]*)\s*$/.exec(cleanText(text));
	return cleanOrderNumber(last?.[1]);
}

/** Price cell: the sale price when a <dl> shows regular + sale. */
function priceText(cell: Sel): string {
	const dl = cell.find("dl").first();
	if (!dl.length) return textOf(cell);
	const sale = dl.find("dd").not(".regular-price, .unit-price").last();
	return textOf(sale.length ? sale : dl);
}

function cellFor($: Doc, row: Sel, column: string): Sel {
	return row
		.find("td[headers]")
		.filter((_, td) =>
			($(td).attr("headers") ?? "").split(/\s+/).includes(column),
		)
		.first();
}

function accountOrder(ctx: PlatformContext): ParsedOrder | undefined {
	const { $, url } = ctx;
	const table = $("table.order-details").first();
	if (!table.length || !table.find("#ColumnProduct, th#ColumnProduct").length)
		return undefined;
	const container = table.closest(".customer, .order, main, body");
	const titleText =
		textOf(table.find("caption").first()) ||
		textOf(
			container
				.find("h2, h1")
				.filter((_, h) => /#/.test($(h).text()))
				.first(),
		);
	const id = orderName(titleText);
	if (!id) return undefined;
	const currencyHint = ctx.currencyHint ?? currencyFromHtml(ctx.html);

	const footRows: Array<{
		label: string;
		value: string;
		kind?: "subtotal" | "shipping" | "tax" | "discount" | "total";
	}> = [];
	table.find("tfoot tr").each((_, tr) => {
		const row = $(tr);
		const head = row.find('[role="rowheader"], th').first();
		const value = row.find('td[role="cell"]').first();
		const idAttr = head.attr("id") ?? "";
		const kind =
			idAttr === "RowSubtotal"
				? "subtotal"
				: idAttr === "RowDiscount"
					? "discount"
					: idAttr === "RowShipping"
						? "shipping"
						: idAttr === "RowTax" || idAttr === "RowDuties"
							? "tax"
							: idAttr === "RowTotal"
								? "total"
								: undefined;
		if (idAttr === "RowTotalRefund") return;
		const valueEl = value.length ? value : row.children("td").last();
		// Discount cells repeat the code name next to the amount.
		const amount = valueEl.find("span").first();
		footRows.push({
			label: textOf(head),
			value:
				kind === "discount" && amount.length ? textOf(amount) : textOf(valueEl),
			kind,
		});
	});
	const totals = foldTotals(footRows, currencyHint);
	const currency = totals.currency;

	const items: ParsedItem[] = [];
	const shipments: ParsedShipment[] = [];
	table.find("tbody tr").each((_, tr) => {
		const row = $(tr);
		const product = row
			.find('td[headers="ColumnProduct"], [headers="ColumnProduct"]')
			.first();
		if (!product.length) return;
		const link = product.find("a").first();
		const titleEl = link.length ? link : product.find("p").first();
		const title = textOf(titleEl);
		const variant =
			textOf(product.find(".properties span").first()) || undefined;
		const quantity = quantityOf(textOf(cellFor($, row, "ColumnQuantity"))) ?? 1;
		const unit = minorOf(priceText(cellFor($, row, "ColumnPrice")), currency);
		const total = minorOf(priceText(cellFor($, row, "ColumnTotal")), currency);
		items.push(
			defined({
				title,
				sku: textOf(cellFor($, row, "ColumnSku")) || undefined,
				variant,
				quantity,
				unitPriceMinor: unit,
				totalMinor: total ?? (unit === undefined ? undefined : unit * quantity),
				itemUrl: absUrl(link.attr("href"), url),
				imageUrl: imageUrl(product.find("img"), url),
			}),
		);
		const fulfillment = product.find(".fulfillment");
		if (fulfillment.length) {
			const text = textOf(fulfillment);
			const company = textOf(fulfillment.find("span").last());
			const explicit = /#\s*([A-Z0-9]{6,40})\b/i.exec(company)?.[1];
			const found = explicit
				? [
						{
							trackingNumber: explicit,
							carrier: cleanText(company.replace(/#.*$/, "")) || undefined,
						},
					]
				: findTrackingNumbers(text);
			for (const t of found)
				shipments.push(
					defined({ trackingNumber: t.trackingNumber, carrier: t.carrier }),
				);
		}
	});

	const time = container.find("time[datetime]").first();
	return defined({
		externalOrderId: id,
		orderUrl: url,
		orderDate: parseDate(time.attr("datetime") ?? textOf(time)),
		...totals,
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
		shipments: shipments.length ? shipments : undefined,
	});
}

/** The legacy `Shopify.checkout = {…};` global on checkout.liquid pages. */
function legacyCheckout(ctx: PlatformContext): ParsedOrder | undefined {
	const { $ } = ctx;
	let checkout: Record<string, unknown> | undefined;
	$("script:not([src])").each((_, el) => {
		if (checkout) return;
		const code = $(el).text();
		const m = /Shopify\.checkout\s*=\s*(\{)/.exec(code);
		if (!m) return;
		const start = (m.index ?? 0) + m[0].length - 1;
		const literal = balancedObjectAt(code, start);
		const parsed = literal ? parseLooseJson(literal) : undefined;
		if (isRecord(parsed)) checkout = parsed;
	});
	if (!checkout) return undefined;
	const c = checkout;
	const currency =
		normalizeCurrencyCode(str(c.presentment_currency) ?? str(c.currency)) ??
		ctx.currencyHint;
	const m = (v: unknown) =>
		num(v) === undefined ? undefined : toMinor(num(v) as number, currency);
	const items: ParsedItem[] = records(c.line_items ?? []).map((li) => {
		const quantity = num(li.quantity) ?? 1;
		const unit = m(li.price);
		return defined({
			title: str(li.title) ?? str(li.presentment_title) ?? "",
			sku: str(li.sku),
			variant: str(li.variant_title),
			quantity,
			unitPriceMinor: unit,
			totalMinor:
				m(li.line_price) ?? (unit === undefined ? undefined : unit * quantity),
			externalItemId: str(li.variant_id),
		});
	});
	const shown = textOf($(".os-order-number").first());
	const id =
		(shown ? orderName(shown) : undefined) ??
		cleanOrderNumber(
			str(c.order_name) ?? str(c.order_number) ?? str(c.order_id),
		);
	if (!id) return undefined;
	const discount = isRecord(c.discount) ? m(c.discount.amount) : undefined;
	return defined({
		externalOrderId: id,
		orderDate: parseDate(str(c.created_at)),
		currency,
		subtotalMinor: m(c.subtotal_price),
		taxMinor: m(c.total_tax),
		shippingMinor: isRecord(c.shipping_rate)
			? m(c.shipping_rate.price)
			: undefined,
		discountMinor: discount,
		totalMinor: m(c.payment_due ?? c.total_price),
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
	});
}

export const shopify: Platform = {
	id: "shopify",
	detect: (html, url) =>
		/Shopify\.checkout\s*=/.test(html) ||
		(SHOPIFY_RE.test(html) &&
			(ORDER_URL_RE.test(url) ||
				/<table[^>]*class="order-details"|os-order-number/.test(html))),
	parse(ctx) {
		const out: ParsedOrder[] = [];
		const legacy = legacyCheckout(ctx);
		if (legacy) out.push(legacy);
		const account = accountOrder(ctx);
		if (account) out.push(account);
		return out;
	},
};
