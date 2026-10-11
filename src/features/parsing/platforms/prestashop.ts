/**
 * PrestaShop 1.7 / 8 order pages, from the classic theme
 * (PrestaShop/classic-theme, develop 2026):
 *
 * - `checkout/order-confirmation.tpl` (`index.php?controller=order-confirmation`,
 *   `<body id="order-confirmation">`): `#order-items .order-line` rows with
 *   `.details span` (name) and `.qty .row > div` (unit price, quantity, line
 *   total), a subtotals `<table>` (label/value cells, `tr.total-value`,
 *   `tr.sub.taxes`), and `#order-details li#order-reference-value`
 *   ("Order reference: XKBKNABJK").
 * - `customer/order-detail.tpl` (`controller=order-detail`,
 *   `<body id="order-detail">`): `#order-infos strong` ("Order Reference
 *   XKBKNABJK - placed on 10/03/2026"), `#order-history` (newest status
 *   first), `table#order-products` rows and `tfoot tr.line-<type>`.
 *
 * The human order identifier in PrestaShop is the 9-letter order reference.
 * The store currency comes from the `prestashop` JS global
 * (`currency.iso_code`).
 */
import { parseDate } from "../dates";
import { absUrl, imageUrl, textOf } from "../html";
import { normalizeStatus } from "../status";
import { cleanText, extractLast4 } from "../text";
import type { ParsedItem, ParsedOrder } from "../types";
import {
	currencyFromHtml,
	dayFirstFor,
	defined,
	foldTotals,
	minorOf,
	quantityOf,
	type TotalKind,
} from "./shared";
import type { Platform, PlatformContext } from "./types";

const PAGE_RE =
	/<body[^>]*\bid=["']order-(?:confirmation|detail)["']|controller=order-(?:confirmation|detail)/i;
const PS_RE =
	/var\s+prestashop\s*=|\bprestashop\b[^<]{0,200}\b(?:static_token|urls)|id="order-reference-value"|id="order-infos"/i;

/** PrestaShop references are 9 upper-case letters (older shops: digits). */
function referenceFrom(text: string): string | undefined {
	const t = cleanText(text);
	const afterColon = /:\s*([A-Z0-9]{6,16})\s*$/.exec(t)?.[1];
	if (afterColon) return afterColon;
	return (
		/\b([A-Z]{9})\b/.exec(t)?.[1] ??
		/\b([A-Z0-9]{6,16})\b(?=\s*[-–])/.exec(t)?.[1]
	);
}

const LINE_KIND: Record<string, TotalKind> = {
	"line-products": "subtotal",
	"line-discount": "discount",
	"line-discounts": "discount",
	"line-shipping": "shipping",
	"line-tax": "tax",
	"line-total": "total",
};

function kindFromClass(cls: string): TotalKind | undefined {
	for (const c of cls.split(/\s+/)) if (LINE_KIND[c]) return LINE_KIND[c];
	return undefined;
}

function confirmation(
	ctx: PlatformContext,
	currencyHint: string | undefined,
): ParsedOrder | undefined {
	const { $, url } = ctx;
	const refText = textOf($("#order-reference-value").first());
	const id = refText ? referenceFrom(refText) : undefined;
	if (!id) return undefined;
	const rows: Array<{ label: string; value: string; kind?: TotalKind }> = [];
	$("#order-items table tr").each((_, tr) => {
		const row = $(tr);
		if (row.hasClass("taxes")) {
			rows.push({
				label: textOf(row.find(".label")),
				value: textOf(row.find(".value")),
				kind: "tax",
			});
			return;
		}
		const cells = row.children("td");
		if (cells.length < 2) return;
		const label = textOf(cells.first());
		rows.push({
			label,
			value: textOf(cells.last()),
			kind: row.hasClass("total-value") ? "total" : undefined,
		});
	});
	const totals = foldTotals(rows, currencyHint);
	const items: ParsedItem[] = [];
	$("#order-items .order-line").each((_, el) => {
		const line = $(el);
		const details = line.find(".details").first();
		const link = details.find("a").first();
		const title = textOf(details.find("span").first()) || textOf(link);
		const cols = line.find(".qty .row").first().children("div");
		const quantity = quantityOf(textOf(cols.eq(1))) ?? 1;
		items.push(
			defined({
				title,
				quantity,
				unitPriceMinor: minorOf(textOf(cols.eq(0)), totals.currency),
				totalMinor: minorOf(textOf(cols.eq(2)), totals.currency),
				itemUrl: absUrl(link.attr("href"), url),
				imageUrl: imageUrl(line.find(".image img"), url),
			}),
		);
	});
	let payment: string | undefined;
	$("#order-details li").each((_, li) => {
		const t = textOf($(li));
		const m =
			/^[^:]*(?:payment|paiement|zahlung|pago|pagamento)[^:]*:\s*(.+)$/i.exec(
				t,
			);
		if (m?.[1] && !payment) payment = m[1];
	});
	return defined({
		externalOrderId: id,
		...totals,
		paymentHint: payment,
		paymentLast4: extractLast4(payment),
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
	});
}

function detail(
	ctx: PlatformContext,
	currencyHint: string | undefined,
): ParsedOrder | undefined {
	const { $, url } = ctx;
	const head = textOf($("#order-infos strong").first());
	const id = head ? referenceFrom(head) : undefined;
	if (!id) return undefined;
	const dateText = head
		.split(/\s[-–]\s/)
		.slice(1)
		.join(" ");
	const table = $("table#order-products").first();
	const rows: Array<{ label: string; value: string; kind?: TotalKind }> = [];
	table.find("tfoot tr").each((_, tr) => {
		const row = $(tr);
		const cells = row.children("td");
		if (cells.length < 2) return;
		rows.push({
			label: textOf(cells.first()),
			value: textOf(cells.last()),
			kind: kindFromClass(row.attr("class") ?? ""),
		});
	});
	const totals = foldTotals(rows, currencyHint);
	const items: ParsedItem[] = [];
	table.find("tr").each((_, tr) => {
		const row = $(tr);
		if (row.closest("thead, tfoot").length) return;
		const cells = row.children("td");
		if (cells.length < 4) return;
		const first = cells.eq(0);
		const link = first.find("a").first();
		const title = textOf(link.length ? link : first.find("strong").first());
		const sku =
			/(?:reference|référence|referenz|referencia|riferimento)\s*:?\s*([^\s]+)/i.exec(
				textOf(first),
			)?.[1];
		const quantity = quantityOf(textOf(cells.eq(1))) ?? 1;
		items.push(
			defined({
				title,
				sku,
				quantity,
				unitPriceMinor: minorOf(textOf(cells.eq(2)), totals.currency),
				totalMinor: minorOf(textOf(cells.eq(3)), totals.currency),
				itemUrl: absUrl(link.attr("href"), url),
			}),
		);
	});
	const statusText =
		textOf($("#order-history tbody tr").first().find("td").eq(1)) || undefined;
	let payment: string | undefined;
	$("#order-infos li").each((_, li) => {
		const label = textOf($(li).find("strong").first());
		if (!payment && /payment|paiement|zahlung|pago|pagamento/i.test(label))
			payment = cleanText(textOf($(li)).slice(label.length)) || undefined;
	});
	return defined({
		externalOrderId: id,
		orderUrl: url,
		orderDate: parseDate(dateText, { dayFirst: dayFirstFor($) }),
		status: statusText ? normalizeStatus(statusText) : undefined,
		statusText,
		...totals,
		paymentHint: payment,
		paymentLast4: extractLast4(payment),
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
	});
}

function parse(ctx: PlatformContext): ParsedOrder[] {
	const currencyHint = ctx.currencyHint ?? currencyFromHtml(ctx.html);
	const out: ParsedOrder[] = [];
	const c = confirmation(ctx, currencyHint);
	if (c) out.push(c);
	const d = detail(ctx, currencyHint);
	if (d) out.push(d);
	return out;
}

export const prestashop: Platform = {
	id: "prestashop",
	detect: (html, url) =>
		(PAGE_RE.test(html) ||
			/controller=order-(?:confirmation|detail)\b/i.test(url)) &&
		PS_RE.test(html),
	parse,
};
