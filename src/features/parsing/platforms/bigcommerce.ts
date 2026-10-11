/**
 * BigCommerce order pages.
 *
 * - Optimized one-page checkout confirmation (`/checkout/order-confirmation`),
 *   rendered by bigcommerce/checkout-js (master, 2026): `OrderStatus.tsx`
 *   `p[data-test="order-confirmation-order-number-text"]` ("Your order
 *   number is <strong>123</strong>"), `OrderSummaryItem.tsx`
 *   `[data-test="cart-item"]` with `[data-test="cart-item-product-title"]`
 *   ("2 x Name") and `.product-price`, `OrderSummaryPrice.tsx` rows
 *   `div[data-test="cart-subtotal|cart-shipping|cart-taxes|cart-discount|cart-total"]`
 *   holding `[data-test="cart-price-value"]`; the total label carries the
 *   shopper currency ("Total (USD)").
 * - Stencil account order details (`/account.php?action=view_order&order_id=`),
 *   Cornerstone `templates/pages/account/orders/details.html`:
 *   `h2.page-heading` "Order #123", `.account-listItem` with
 *   `.account-product-title` ("2 × Name") and `.account-product-price`,
 *   `dl.account-orderTotal` key/value pairs and the sidebar
 *   `dl.definitionList` (status, date, payment method "… ending in 4242").
 */
import { parseDate } from "../dates";
import { type Doc, imageUrl, textOf } from "../html";
import { normalizeCurrencyCode } from "../money";
import { normalizeStatus } from "../status";
import { cleanText, extractLast4 } from "../text";
import type { ParsedItem, ParsedOrder, ParsedShipment } from "../types";
import {
	cleanOrderNumber,
	defined,
	foldTotals,
	minorOf,
	type TotalKind,
} from "./shared";
import type { Platform, PlatformContext } from "./types";

const BC_RE =
	/optimizedCheckout|cdn\d*\.bigcommerce\.com|stencilBootstrap|BCData\s*=|bigcommerce\.com\/s-/i;
const PAGE_RE =
	/\/checkout\/order-confirmation|\/order-confirmation(?:\/|\?|$)|account\.php\?(?:[^#]*&)?action=view_order/i;

/** "2 x Name" / "2 × Name" → [2, "Name"]. */
function splitQty(text: string): { quantity: number; title: string } {
	const m = /^\s*(\d+(?:\.\d+)?)\s*[x×]\s+(.+)$/i.exec(cleanText(text));
	return m?.[1] && m[2]
		? { quantity: Number(m[1]), title: m[2] }
		: { quantity: 1, title: cleanText(text) };
}

function confirmation(ctx: PlatformContext): ParsedOrder | undefined {
	const { $, url } = ctx;
	const numberEl = $(
		'[data-test="order-confirmation-order-number-text"]',
	).first();
	if (!numberEl.length) return undefined;
	const id = cleanOrderNumber(
		textOf(numberEl.find("strong").first()) ||
			/(\d[\w-]*)\s*$/.exec(textOf(numberEl))?.[1],
	);
	if (!id) return undefined;
	const totalLabel = textOf(
		$('[data-test="cart-total"] [data-test="cart-price-label"]').first(),
	);
	const currency =
		normalizeCurrencyCode(/\(([A-Z]{3})\)/.exec(totalLabel)?.[1]) ??
		normalizeCurrencyCode(
			/\(?([A-Z]{3})\)?/.exec(
				textOf($(".cart-priceItem-currencyCode").first()),
			)?.[1],
		) ??
		ctx.currencyHint;
	const KINDS: Array<[string, TotalKind]> = [
		["cart-subtotal", "subtotal"],
		["cart-shipping", "shipping"],
		["cart-handling", "shipping"],
		["cart-taxes", "tax"],
		["cart-discount", "discount"],
		["cart-coupon", "discount"],
		["cart-total", "total"],
	];
	const rows: Array<{ label: string; value: string; kind: TotalKind }> = [];
	for (const [test, kind] of KINDS)
		$(`[data-test="${test}"]`).each((_, el) => {
			const value = $(el).find('[data-test="cart-price-value"]').first();
			rows.push({
				label: test,
				value: textOf(value.length ? value : $(el)),
				kind,
			});
		});
	const totals = foldTotals(rows, currency);
	const items: ParsedItem[] = [];
	$('[data-test="cart-item"]').each((_, el) => {
		const item = $(el);
		const { quantity, title } = splitQty(
			textOf(item.find('[data-test="cart-item-product-title"]').first()),
		);
		const after = item
			.find('[data-test="cart-item-product-price--afterDiscount"]')
			.first();
		const price = after.length
			? after
			: item
					.find(".product-price")
					.not(".product-price--beforeDiscount")
					.last();
		const total = minorOf(textOf(price), totals.currency);
		const options = item
			.find('[data-test="cart-item-product-options"] li')
			.map((_, li) => textOf($(li)))
			.get()
			.join(", ");
		items.push(
			defined({
				title,
				variant: options || undefined,
				quantity,
				totalMinor: total,
				unitPriceMinor:
					total === undefined ? undefined : Math.round(total / quantity),
				imageUrl: imageUrl(item.find("img"), url),
			}),
		);
	});
	return defined({
		externalOrderId: id,
		...totals,
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
	});
}

function definitionPairs(
	$: Doc,
	selector: string,
): Array<{ label: string; value: string }> {
	const out: Array<{ label: string; value: string }> = [];
	$(selector).each((_, dl) => {
		$(dl)
			.children("dt")
			.each((_, dt) => {
				const dd = $(dt).nextAll("dd").first();
				out.push({ label: textOf($(dt)), value: textOf(dd) });
			});
	});
	return out;
}

function accountOrder(ctx: PlatformContext): ParsedOrder | undefined {
	const { $, url } = ctx;
	if (!$(".account-orderTotal, .account-listItem").length) return undefined;
	const heading = textOf($("h2.page-heading, h1.page-heading").first());
	const id = cleanOrderNumber(/#\s*([\w-]+)/.exec(heading)?.[1]);
	if (!id) return undefined;
	const totals = foldTotals(
		definitionPairs($, "dl.account-orderTotal"),
		ctx.currencyHint,
	);
	const items: ParsedItem[] = [];
	$(".account-listItem").each((_, li) => {
		const item = $(li);
		const { quantity, title } = splitQty(
			textOf(item.find(".account-product-title").first()),
		);
		const total = minorOf(
			textOf(item.find(".account-product-price").first()),
			totals.currency,
		);
		items.push(
			defined({
				title,
				quantity,
				totalMinor: total,
				unitPriceMinor:
					total === undefined ? undefined : Math.round(total / quantity),
				imageUrl: imageUrl(item.find("img"), url),
			}),
		);
	});
	const side = definitionPairs($, ".account-sidebar-block dl.definitionList");
	const find = (re: RegExp) =>
		side.find((p) => re.test(p.label))?.value || undefined;
	const statusText = find(/status/i);
	const payment = find(/payment/i);
	const shipments: ParsedShipment[] = [];
	$(".account-sidebar-block dl.definitionList").each((_, dl) => {
		const pairs = $(dl)
			.children("dt")
			.toArray()
			.map((dt) => ({
				label: textOf($(dt)),
				value: textOf($(dt).nextAll("dd").first()),
			}));
		const tracking = pairs.find((p) => /tracking/i.test(p.label))?.value;
		const number = tracking
			? /([A-Z0-9]{8,40})/i.exec(tracking.replace(/\s+/g, ""))?.[1]
			: undefined;
		if (number)
			shipments.push(
				defined({
					trackingNumber: number,
					carrier:
						pairs.find((p) => /method|provider|carrier/i.test(p.label))
							?.value || undefined,
					shippedAt: parseDate(
						pairs.find((p) => /shipped|date/i.test(p.label))?.value,
					),
				}),
			);
	});
	return defined({
		externalOrderId: id,
		orderUrl: url,
		orderDate: parseDate(find(/date/i)),
		status: statusText ? normalizeStatus(statusText) : undefined,
		statusText,
		...totals,
		paymentHint: payment,
		paymentLast4: extractLast4(payment),
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
		shipments: shipments.length ? shipments : undefined,
	});
}

export const bigcommerce: Platform = {
	id: "bigcommerce",
	detect: (html, url) =>
		BC_RE.test(html) &&
		(PAGE_RE.test(url) ||
			/data-test="order-confirmation-order-number-text"|class="account-orderTotal"/.test(
				html,
			)),
	parse(ctx) {
		const out: ParsedOrder[] = [];
		const c = confirmation(ctx);
		if (c) out.push(c);
		const a = accountOrder(ctx);
		if (a) out.push(a);
		return out;
	},
};
