/**
 * WooCommerce order pages, from the plugin's own templates (trunk, 2026):
 *
 * - Classic "order received" (`checkout/thankyou.php`):
 *   `ul.woocommerce-order-overview > li.woocommerce-order-overview__order strong`
 *   (+ __date, __total, __payment-method), then `order/order-details.php`.
 * - My Account → view order (`myaccount/view-order.php`):
 *   `mark.order-number`, `mark.order-date`, `mark.order-status`.
 * - Order details table (`order/order-details.php` + `order-details-item.php`):
 *   `table.woocommerce-table--order-details` rows `tr.woocommerce-table__line-item`
 *   with `td.product-name a`, `strong.product-quantity` ("× 2"),
 *   `td.product-total`; tfoot `<tr><th scope=row>Label:</th><td>value</td></tr>`
 *   from `get_order_item_totals()`.
 * - Block themes' Order Confirmation blocks (`Blocks/BlockTypes/OrderConfirmation`):
 *   `.wc-block-order-confirmation-summary-list-item__key/__value` pairs
 *   ("Order #:", "Date:", "Total:", "Payment:") and
 *   `table.wc-block-order-confirmation-totals__table`.
 */
import { parseDate } from "../dates";
import { absUrl, type Doc, type Sel, textOf } from "../html";
import { normalizeStatus } from "../status";
import { cleanText, extractLast4 } from "../text";
import type { ParsedItem, ParsedOrder } from "../types";
import {
	cleanOrderNumber,
	currencyFromHtml,
	dayFirstFor,
	defined,
	foldTotals,
	minorOf,
	quantityOf,
} from "./shared";
import type { Platform, PlatformContext } from "./types";

const URL_RE = /\/(?:order-received|view-order)\/\d+/i;
const MARKUP_RE =
	/woocommerce-order-overview|woocommerce-table--order-details|wc-block-order-confirmation-(?:summary|totals)|class="[^"]*\bwoocommerce-(?:order-received|view-order)\b|<mark class="order-number"/i;

type SummaryKey = "order" | "date" | "total" | "payment";

/**
 * Block summary rows are rendered in a fixed order (Order #, Date, Total,
 * Email, Payment; empty ones are skipped) with translated labels, so match
 * by label first and fall back to position / content.
 */
function summaryValue($: Doc, key: SummaryKey): Sel | undefined {
	const rows = $(".wc-block-order-confirmation-summary-list-item")
		.toArray()
		.map((li) => ({
			label: textOf(
				$(li).find(".wc-block-order-confirmation-summary-list-item__key"),
			),
			value: $(li).find(
				".wc-block-order-confirmation-summary-list-item__value",
			),
		}));
	if (rows.length === 0) return undefined;
	const LABELS: Record<SummaryKey, RegExp> = {
		order: /order|bestell|commande|pedido|ordine|bestelling|zamówieni/i,
		date: /date|datum|fecha|data/i,
		total: /total|gesamt|summe|montant|importe|totale|totaal/i,
		payment: /pay|zahl|paiement|pago|pagamento|betaal|płatno/i,
	};
	const byLabel = rows.find((r) => LABELS[key].test(r.label));
	if (byLabel) return byLabel.value;
	switch (key) {
		case "order":
			return rows[0]?.value;
		case "date":
			return rows[1]?.value;
		case "total":
			return rows.find((r) => r.value.find(".woocommerce-Price-amount").length)
				?.value;
		case "payment": {
			const last = rows[rows.length - 1];
			return last && rows.length > 3 && !/@/.test(textOf(last.value))
				? last.value
				: undefined;
		}
	}
}

function overviewValue($: Doc, cls: string, legacy: string): string {
	const scope = $(".woocommerce-order-overview, ul.order_details").first();
	return textOf(
		scope
			.find(`.woocommerce-order-overview__${cls} strong, li.${legacy} strong`)
			.first(),
	);
}

function items(
	$: Doc,
	base: string,
	currency: string | undefined,
): ParsedItem[] {
	const out: ParsedItem[] = [];
	$(
		[
			".woocommerce-table--order-details tbody tr",
			"table.order_details tbody tr",
			".wc-block-order-confirmation-totals__table tbody tr",
		].join(", "),
	).each((_, tr) => {
		const row = $(tr);
		if (row.hasClass("product-purchase-note")) return;
		const nameCell = row
			.find(
				"td.product-name, td.woocommerce-table__product-name, td.wc-block-order-confirmation-totals__product",
			)
			.first();
		if (!nameCell.length) return;
		const qtyEl = nameCell.find(".product-quantity").first();
		// Refunded lines render "× <del>2</del> <ins>1</ins>".
		const qtyText = qtyEl.find("ins").length
			? textOf(qtyEl.find("ins"))
			: textOf(qtyEl);
		const quantity = quantityOf(qtyText) ?? 1;
		const link = nameCell.find("a").first();
		const meta = nameCell.find(".wc-item-meta, ul, .product-purchase-note");
		const clone = nameCell.clone();
		clone
			.find(".product-quantity, .wc-item-meta, ul, .product-purchase-note")
			.remove();
		const title = cleanText(textOf(link.length ? link : clone)).replace(
			/\s*[×x]\s*\d+\s*$/,
			"",
		);
		const totalCell = row
			.find(
				"td.product-total, td.woocommerce-table__product-total, td.wc-block-order-confirmation-totals__total",
			)
			.first();
		const lineTotal = minorOf(textOf(totalCell), currency);
		const variant = meta.length
			? textOf(meta.first()).replace(/\s*:\s*/g, ": ") || undefined
			: undefined;
		out.push(
			defined({
				title,
				variant,
				quantity,
				totalMinor: lineTotal,
				unitPriceMinor:
					lineTotal === undefined
						? undefined
						: Math.round(lineTotal / quantity),
				itemUrl: absUrl(link.attr("href"), base),
			}),
		);
	});
	return out.filter((i) => i.title);
}

function parse(ctx: PlatformContext): ParsedOrder[] {
	const { $, url } = ctx;
	const blockId = summaryValue($, "order");
	const idText =
		overviewValue($, "order", "order") ||
		(blockId ? textOf(blockId) : "") ||
		textOf($("mark.order-number").first());
	const id = cleanOrderNumber(idText);
	if (!id) return [];
	const currencyHint = ctx.currencyHint ?? currencyFromHtml(ctx.html);

	const tfoot = $(
		".woocommerce-table--order-details tfoot tr, table.order_details tfoot tr, .wc-block-order-confirmation-totals__table tfoot tr",
	);
	const rows: Array<{ label: string; value: string }> = [];
	let paymentText = "";
	let includedTax: string | undefined;
	tfoot.each((_, tr) => {
		const row = $(tr);
		const label = textOf(row.children("th").first());
		const valueCell = row.children("td").last();
		if (/payment/i.test(label)) paymentText = textOf(valueCell);
		const incl = valueCell.find(".includes_tax");
		if (incl.length) includedTax = textOf(incl);
		const value = valueCell.clone();
		value.find(".includes_tax, .shipped_via").remove();
		rows.push({ label, value: textOf(value) });
	});
	const overviewTotal = overviewValue($, "total", "total");
	const blockTotal = summaryValue($, "total");
	const totalText = overviewTotal || (blockTotal ? textOf(blockTotal) : "");
	if (totalText) rows.push({ label: "Total", value: totalText });
	const totals = foldTotals(rows, currencyHint);
	if (totals.taxMinor === undefined && includedTax)
		totals.taxMinor = minorOf(includedTax, totals.currency);

	const blockDate = summaryValue($, "date");
	const dateText =
		overviewValue($, "date", "date") ||
		(blockDate ? textOf(blockDate) : "") ||
		textOf($("mark.order-date").first());
	const statusText = textOf($("mark.order-status").first()) || undefined;
	const blockPayment = summaryValue($, "payment");
	const payment =
		overviewValue($, "payment-method", "method") ||
		(blockPayment ? textOf(blockPayment) : "") ||
		paymentText;
	const lineItems = items($, url, totals.currency);
	return [
		defined({
			externalOrderId: id,
			orderDate: parseDate(dateText, { dayFirst: dayFirstFor($) }),
			status: statusText ? normalizeStatus(statusText) : undefined,
			statusText,
			...totals,
			paymentHint: payment || undefined,
			paymentLast4: extractLast4(payment),
			items: lineItems.length ? lineItems : undefined,
		}),
	];
}

export const woocommerce: Platform = {
	id: "woocommerce",
	detect: (html, url) =>
		MARKUP_RE.test(html) || (URL_RE.test(url) && /woocommerce/i.test(html)),
	parse,
};
