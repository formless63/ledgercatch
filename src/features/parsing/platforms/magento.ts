/**
 * Magento 2 / Adobe Commerce (Luma and Blank-derived themes), from
 * magento/magento2 2.4-develop templates:
 *
 * - `Magento_Checkout::success.phtml` (`/checkout/onepage/success/`):
 *   `.checkout-success` with `a.order-number strong` (logged in) or
 *   "Your order # is: <span>…</span>" (guest). Only the number is shown;
 *   totals come from a GA4 data layer when the shop has one.
 * - `Magento_Sales::order/*` (`/sales/order/view/order_id/<entity id>/`,
 *   `/sales/guest/view/`): page title "Order # 000000123", `span.order-status`,
 *   `.order-date` ("Order Date: <span>October 3, 2026</span>"),
 *   `table#my-orders-table` with `tr[id^=order-item-row]`
 *   (`.product-item-name`, `td.col.sku`, `td.col.price .price`,
 *   `ul.items-qty` "Ordered N", `td.col.subtotal .price`) and tfoot total
 *   rows whose class is the total code (`subtotal`, `discount`, `shipping`,
 *   `totals-tax`, `grand_total`, `grand_total_incl`).
 *
 * The human order number is the increment id (e.g. 000000123), never the
 * `order_id` entity id in the URL.
 */
import { parseDate } from "../dates";
import { absUrl, type Sel, textOf } from "../html";
import { normalizeStatus } from "../status";
import { cleanText } from "../text";
import type { ParsedItem, ParsedOrder } from "../types";
import {
	cleanOrderNumber,
	currencyFromHtml,
	dayFirstFor,
	defined,
	foldTotals,
	minorOf,
	quantityOf,
	type TotalKind,
} from "./shared";
import type { Platform, PlatformContext } from "./types";

const MAGENTO_RE =
	/x-magento-init|data-mage-init|\/static\/(?:version\d+\/)?frontend\/|Magento_[A-Z]\w+\/|mage\/cookies/i;
const PAGE_RE =
	/\/checkout\/onepage\/success|\/sales\/(?:order|guest)\/(?:view|print)/i;
const BODY_RE =
	/<body[^>]*class=["'][^"']*\b(?:checkout-onepage-success|sales-order-view|sales-guest-view|sales-order-print)\b/i;

const CLASS_KIND: Array<[RegExp, TotalKind]> = [
	[/\bgrand_total_incl\b/, "total"],
	[/\bgrand_total\b/, "total"],
	[/\bsubtotal(_incl|_excl)?\b/, "subtotal"],
	[/\bdiscount\b/, "discount"],
	[/\bshipping(_incl|_excl)?\b/, "shipping"],
	[/\b(totals-)?tax\b/, "tax"],
];

function priceIn(cell: Sel): string {
	// When both prices show, prefer the tax-inclusive one.
	const incl = cell.find(".price-including-tax .price").first();
	if (incl.length) return textOf(incl);
	const price = cell.find(".price").first();
	return textOf(price.length ? price : cell);
}

function success(ctx: PlatformContext): ParsedOrder | undefined {
	const { $, url } = ctx;
	const box = $(".checkout-success").first();
	if (!box.length) return undefined;
	const link = box.find("a.order-number").first();
	const text = link.length
		? textOf(link)
		: textOf(box.find("p span").first()) ||
			textOf(box.find("p strong").first());
	const id = cleanOrderNumber(text);
	if (!id) return undefined;
	const viewUrl = absUrl(link.attr("href"), url);
	return defined({ externalOrderId: id, orderUrl: viewUrl ?? url });
}

function view(ctx: PlatformContext): ParsedOrder | undefined {
	const { $, url } = ctx;
	const title = textOf(
		$(".page-title .base, h1.page-title, .page-title-wrapper h1").first(),
	);
	const id = cleanOrderNumber(/#\s*([\w-]+)/.exec(title)?.[1]);
	if (!id) return undefined;
	const table = $("table#my-orders-table, table.table-order-items").first();
	const currencyHint = ctx.currencyHint ?? currencyFromHtml(ctx.html);
	const rows: Array<{ label: string; value: string; kind?: TotalKind }> = [];
	table.find("tfoot tr").each((_, tr) => {
		const row = $(tr);
		const cls = row.attr("class") ?? "";
		if (/base_grandtotal|order-pager/.test(cls)) return;
		const th = row.children("th").first();
		const td = row.children("td").last();
		if (!th.length || !td.length) return;
		const kind = CLASS_KIND.find(([re]) => re.test(cls))?.[1];
		const label = textOf(th);
		// "Grand Total (Excl.Tax)" must not win over the incl. row.
		rows.push({
			label: kind === "total" && /_incl/.test(cls) ? `${label} incl` : label,
			value: priceIn(td),
			kind,
		});
	});
	const totals = foldTotals(rows, currencyHint);
	const items: ParsedItem[] = [];
	table.find('tbody tr[id^="order-item-row"]').each((_, tr) => {
		const row = $(tr);
		const title = textOf(
			row.find(".product-item-name, td.col.name strong").first(),
		);
		const options = row.find("dl.item-options").first();
		const variant = options.length
			? cleanText(
					options
						.children("dt")
						.map(
							(i, dt) =>
								`${textOf($(dt))}: ${textOf(options.children("dd").eq(i))}`,
						)
						.get()
						.join(", "),
				) || undefined
			: undefined;
		let quantity: number | undefined;
		row.find("ul.items-qty li").each((_, li) => {
			const label = textOf($(li).find(".title"));
			if (quantity === undefined && /order|bestellt|command|pedid/i.test(label))
				quantity = quantityOf(textOf($(li).find(".content")));
		});
		quantity ??= quantityOf(textOf(row.find("td.col.qty"))) ?? 1;
		const unit = minorOf(
			priceIn(row.find("td.col.price").first()),
			totals.currency,
		);
		const total = minorOf(
			priceIn(row.find("td.col.subtotal").first()),
			totals.currency,
		);
		items.push(
			defined({
				title,
				sku: textOf(row.find("td.col.sku").first()) || undefined,
				variant,
				quantity,
				unitPriceMinor: unit,
				totalMinor: total,
			}),
		);
	});
	const statusText = textOf($(".order-status").first()) || undefined;
	const dateEl = $(".order-date").first();
	const dateText =
		textOf(dateEl.find("span").not(".label").first()) || textOf(dateEl);
	const payment = textOf(
		$(
			".box-order-billing-method .box-content dt, .box-order-billing-method .box-content",
		).first(),
	);
	return defined({
		externalOrderId: id,
		orderUrl: url,
		orderDate: parseDate(dateText, { dayFirst: dayFirstFor($) }),
		status: statusText ? normalizeStatus(statusText) : undefined,
		statusText,
		...totals,
		paymentHint: payment || undefined,
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
	});
}

export const magento: Platform = {
	id: "magento",
	detect: (html, url) =>
		(PAGE_RE.test(url) || BODY_RE.test(html)) && MAGENTO_RE.test(html),
	parse(ctx) {
		const out: ParsedOrder[] = [];
		const v = view(ctx);
		if (v) out.push(v);
		const s = success(ctx);
		if (s && !v) out.push(s);
		return out;
	},
};
