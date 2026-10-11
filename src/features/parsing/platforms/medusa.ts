/**
 * Medusa v2 storefronts.
 *
 * HTML, from medusajs/nextjs-starter-medusa (main, 2026), the base of most
 * Medusa storefronts:
 * - `/[countryCode]/order/[id]/confirmed` → `OrderCompletedTemplate`
 *   (`[data-testid="order-complete-container"]`).
 * - `/[countryCode]/account/orders/details/[id]` → `OrderDetailsTemplate`
 *   (`[data-testid="order-details-container"]`).
 * Both render `OrderDetails`: `[data-testid="order-id"]` (the human
 * `display_id`), `[data-testid="order-date"]` (`Date#toDateString()`),
 * `[data-testid="order-status"]`; `Item`: `[data-testid="product-row"]` with
 * `product-name`, `product-variant` ("Variant: …"), `product-quantity`,
 * `product-unit-price`, `product-price`; and `CartTotals` spans
 * `cart-subtotal|cart-shipping|cart-discount|cart-taxes|cart-total` whose
 * `data-value` attribute is the raw amount (major units in v2). The account
 * page uses `OrderSummary` (plain "Subtotal/Discount/Shipping/Taxes/Total"
 * rows) instead of `CartTotals`.
 *
 * JSON, Store API `GET /store/orders/:id` → `{ order }` (and
 * `/store/orders` → `{ orders }`). Medusa v2 returns amounts as decimal
 * numbers in major units (BigNumber-serialized); v1 returned integer minor
 * units. v2 is recognised by its v2-only total fields (`original_total`,
 * `item_subtotal`, `original_item_total`, …).
 */
import { parseDate } from "../dates";
import { absUrl, imageUrl, linesOf, textOf } from "../html";
import { isRecord, type JsonRecord, num, records, str } from "../json";
import { normalizeCurrencyCode, parseMoney, toMinor } from "../money";
import { normalizeStatus } from "../status";
import { cleanText, extractLast4, moneyAfterLabel } from "../text";
import type {
	OrderStatus,
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
} from "../types";
import { cleanOrderNumber, defined, minorOf, quantityOf } from "./shared";
import type { Platform, PlatformContext } from "./types";

const CONTAINER_RE = /data-testid=["']order-(?:complete|details)-container["']/;

function parseHtml(ctx: PlatformContext): ParsedOrder[] {
	const { $, url } = ctx;
	const container = $(
		'[data-testid="order-complete-container"], [data-testid="order-details-container"]',
	).first();
	if (!container.length) return [];
	const id = cleanOrderNumber(
		textOf(container.find('[data-testid="order-id"]').first()),
	);
	if (!id) return [];

	// Currency: from the formatted total (Intl en-US output: "$", "€", "CA$", "£" …).
	const totalEl = container.find('[data-testid="cart-total"]').first();
	const firstPrice = textOf(
		container.find('[data-testid="product-price"]').first(),
	);
	const currency =
		parseMoney(textOf(totalEl) || firstPrice, { currency: ctx.currencyHint })
			?.currency ?? ctx.currencyHint;
	const fromData = (testid: string): number | undefined => {
		const el = container.find(`[data-testid="${testid}"]`).first();
		if (!el.length) return undefined;
		const raw = el.attr("data-value");
		if (raw !== undefined && /^-?\d+(\.\d+)?$/.test(raw.trim()))
			return toMinor(raw.trim(), currency);
		return minorOf(textOf(el), currency);
	};
	let totals: Pick<
		ParsedOrder,
		| "subtotalMinor"
		| "shippingMinor"
		| "taxMinor"
		| "discountMinor"
		| "totalMinor"
	>;
	if (totalEl.length) {
		const discount = fromData("cart-discount");
		totals = {
			subtotalMinor: fromData("cart-subtotal"),
			shippingMinor: fromData("cart-shipping"),
			taxMinor: fromData("cart-taxes"),
			discountMinor: discount === undefined ? undefined : Math.abs(discount),
			totalMinor: fromData("cart-total"),
		};
	} else {
		// Account page: OrderSummary has no test ids; read its labeled rows.
		const heading = container
			.find("h2")
			.filter((_, h) => /summary/i.test($(h).text()))
			.first();
		const text = linesOf(heading.length ? heading.parent() : container).join(
			"\n",
		);
		const opts = { currency };
		totals = {
			subtotalMinor: moneyAfterLabel(text, /^subtotal\b/im, opts)?.amountMinor,
			shippingMinor: moneyAfterLabel(text, /^shipping\b/im, opts)?.amountMinor,
			taxMinor: moneyAfterLabel(text, /^taxes\b/im, opts)?.amountMinor,
			discountMinor: (() => {
				const d = moneyAfterLabel(text, /^discount\b/im, opts)?.amountMinor;
				return d === undefined ? undefined : Math.abs(d);
			})(),
			totalMinor: moneyAfterLabel(text, /^total\b/im, { ...opts, last: true })
				?.amountMinor,
		};
	}

	const items: ParsedItem[] = [];
	container.find('[data-testid="product-row"]').each((_, el) => {
		const row = $(el);
		const quantity =
			quantityOf(
				textOf(row.find('[data-testid="product-quantity"]').first()),
			) ?? 1;
		const variant = textOf(
			row.find('[data-testid="product-variant"]').first(),
		).replace(/^variant:\s*/i, "");
		items.push(
			defined({
				title: textOf(row.find('[data-testid="product-name"]').first()),
				variant: variant || undefined,
				quantity,
				unitPriceMinor: minorOf(
					textOf(row.find('[data-testid="product-unit-price"]').first()),
					currency,
				),
				totalMinor: minorOf(
					textOf(row.find('[data-testid="product-price"]').first()),
					currency,
				),
				imageUrl: imageUrl(row.find("img"), url),
			}),
		);
	});
	const statusText =
		textOf(container.find('[data-testid="order-status"]').first()) || undefined;
	const payment =
		textOf(container.find('[data-testid="payment-method"]').first()) ||
		undefined;
	const paymentAmount = textOf(
		container.find('[data-testid="payment-amount"]').first(),
	);
	return [
		defined({
			externalOrderId: id,
			orderDate: parseDate(
				textOf(container.find('[data-testid="order-date"]').first()),
			),
			status: statusText ? fulfillmentStatus(statusText) : undefined,
			statusText,
			currency,
			...defined(totals),
			paymentHint: payment,
			paymentLast4:
				/\*{4}\s*(\d{4})\s*$/.exec(paymentAmount)?.[1] ??
				extractLast4(paymentAmount),
			items: items.filter((i) => i.title).length
				? items.filter((i) => i.title)
				: undefined,
			orderUrl: url,
		}),
	];
}

/** Medusa fulfillment_status values ("not_fulfilled", "shipped", …). */
function fulfillmentStatus(value: string): OrderStatus | undefined {
	const v = cleanText(value)
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	if (/^(not_fulfilled|partially_fulfilled|fulfilled)$/.test(v))
		return "processing";
	if (/^(partially_shipped|shipped)$/.test(v)) return "shipped";
	if (/^(partially_delivered|delivered)$/.test(v)) return "delivered";
	if (v === "canceled" || v === "cancelled") return "cancelled";
	if (/returned|refunded/.test(v)) return "returned";
	return normalizeStatus(value);
}

const V2_FIELDS = [
	"original_total",
	"original_subtotal",
	"item_subtotal",
	"item_total",
	"original_item_total",
	"original_item_subtotal",
	"shipping_subtotal",
	"credit_line_total",
];

function isMedusaOrder(o: JsonRecord): boolean {
	return (
		typeof o.id === "string" &&
		/^order_/.test(o.id) &&
		o.display_id !== undefined &&
		typeof o.currency_code === "string"
	);
}

/** Maps a Store API order object; `v2` decides major vs minor units. */
export function medusaOrderFromJson(
	o: JsonRecord,
	base: string,
): ParsedOrder | undefined {
	if (!isMedusaOrder(o)) return undefined;
	const id = cleanOrderNumber(str(o.display_id));
	if (!id) return undefined;
	const currency = normalizeCurrencyCode(str(o.currency_code));
	const v2 =
		V2_FIELDS.some((k) => k in o) ||
		records(o.items).some((i) => "original_total" in i);
	const m = (v: unknown): number | undefined => {
		const n = isRecord(v) ? num(v.value) : num(v);
		if (n === undefined) return undefined;
		return v2 ? toMinor(n, currency) : Math.round(n);
	};
	const items: ParsedItem[] = records(o.items).map((it) => {
		const quantity = num(it.quantity) ?? 1;
		const unit = m(it.unit_price);
		const variant = isRecord(it.variant) ? it.variant : undefined;
		return defined({
			externalItemId: str(it.id),
			title: str(it.product_title) ?? str(it.title) ?? "",
			variant: str(it.variant_title) ?? str(variant?.title),
			sku: str(it.variant_sku) ?? str(variant?.sku),
			quantity,
			unitPriceMinor: unit,
			totalMinor:
				m(it.total) ?? (unit === undefined ? undefined : unit * quantity),
			imageUrl: absUrl(str(it.thumbnail), base),
		});
	});
	const shipments: ParsedShipment[] = [];
	for (const f of records(o.fulfillments)) {
		for (const label of records(f.labels))
			if (str(label.tracking_number))
				shipments.push(
					defined({ trackingNumber: str(label.tracking_number) as string }),
				);
		for (const link of records(f.tracking_links))
			if (str(link.tracking_number))
				shipments.push(
					defined({ trackingNumber: str(link.tracking_number) as string }),
				);
	}
	let last4: string | undefined;
	for (const pc of records(o.payment_collections))
		for (const p of records(pc.payments))
			if (!last4 && isRecord(p.data)) last4 = str(p.data.card_last4);
	const status =
		str(o.status) === "canceled"
			? "cancelled"
			: str(o.fulfillment_status)
				? fulfillmentStatus(str(o.fulfillment_status) as string)
				: undefined;
	const discount = m(o.discount_total);
	return defined({
		externalOrderId: id,
		orderDate: parseDate(str(o.created_at)),
		status,
		statusText: str(o.fulfillment_status) ?? str(o.status),
		currency,
		subtotalMinor: m(o.item_subtotal ?? o.subtotal),
		shippingMinor: m(o.shipping_total),
		taxMinor: m(o.tax_total),
		discountMinor:
			discount === undefined || discount === 0 ? undefined : Math.abs(discount),
		totalMinor: m(o.total),
		paymentLast4: last4,
		items: items.filter((i) => i.title).length
			? items.filter((i) => i.title)
			: undefined,
		shipments: shipments.length ? shipments : undefined,
	});
}

/** `{ order }` / `{ orders: [...] }` Store API bodies. */
export function medusaJsonOrders(body: unknown, base: string): ParsedOrder[] {
	if (!isRecord(body)) return [];
	const list = isRecord(body.order) ? [body.order] : records(body.orders);
	return list
		.map((o) => medusaOrderFromJson(o, base))
		.filter((o): o is ParsedOrder => Boolean(o));
}

export const medusa: Platform = {
	id: "medusa",
	detect: (html) =>
		CONTAINER_RE.test(html) && /data-testid=["']order-id["']/.test(html),
	parse: parseHtml,
};
