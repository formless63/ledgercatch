/**
 * Amazon (.com / .ca / .co.uk / .de, other marketplaces best-effort).
 *
 * Amazon has no order JSON API; everything is server-rendered HTML. Selectors
 * follow alexdlaird/amazon-orders + philipmulcahy/azad (verified 2026):
 *   - order history: `.order-card` / `.js-order-card` / `div.order`, header
 *     `.order-header__header-list-item` (2024+) or `.a-column` label/value
 *     pairs (legacy), id in `.yohtmlc-order-id [dir=ltr]`; Amazon Business
 *     (2026): `#orderCard.a-box-group` cards, `#orderCardHeader .a-column`
 *     label/value pairs, id in `#orderIdField [dir=auto]`, items in
 *     `.itemDetails` rows;
 *   - order details & printable summary (print.html, same markup since 2025):
 *     `[data-component=…]` blocks (orderDate, orderId, chargeSummary,
 *     purchasedItems, unitPrice, quantity, orderedMerchant, shipments) with
 *     legacy fallbacks (`.order-date-invoice-item`, `#od-subtotals`,
 *     `.yohtmlc-item`, `.a-color-price`);
 *   - legacy table print.html: text heuristics ("Grand Total:").
 *
 * Order ids are only taken from scoped elements/hrefs: the session-id cookie
 * has the same NNN-NNNNNNN-NNNNNNN shape and appears in telemetry.
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
	type Sel,
	textOf,
} from "./html";
import { queryParam } from "./json";
import { findMoneyStrings, parseMoney } from "./money";
import { buildResult, safeParse } from "./result";
import { normalizeStatus } from "./status";
import { cleanText, extractLast4, moneyAfterLabel } from "./text";
import type {
	ParsedItem,
	ParsedOrder,
	ParseResult,
	ParserInput,
	StoreParser,
} from "./types";

const ORDER_ID_RE = /\b(?:D\d{2}|\d{3})-\d{7}-\d{7}\b/;

const MARKETPLACE_CURRENCY: Array<[RegExp, string]> = [
	[/amazon\.com\.au$/, "AUD"],
	[/amazon\.com\.br$/, "BRL"],
	[/amazon\.com\.mx$/, "MXN"],
	[/amazon\.com\.tr$/, "TRY"],
	[/amazon\.com$/, "USD"],
	[/amazon\.ca$/, "CAD"],
	[/amazon\.co\.uk$/, "GBP"],
	[/amazon\.(de|fr|it|es|nl|ie|com\.be)$/, "EUR"],
	[/amazon\.co\.jp$/, "JPY"],
	[/amazon\.in$/, "INR"],
	[/amazon\.se$/, "SEK"],
	[/amazon\.pl$/, "PLN"],
	[/amazon\.sg$/, "SGD"],
	[/amazon\.ae$/, "AED"],
	[/amazon\.sa$/, "SAR"],
];

function marketplace(pageUrl: string): {
	origin: string;
	currency?: string;
	dayFirst: boolean;
} {
	try {
		const url = new URL(pageUrl);
		const host = url.hostname.toLowerCase();
		const currency = MARKETPLACE_CURRENCY.find(([re]) => re.test(host))?.[1];
		return {
			origin: url.origin,
			currency,
			dayFirst: !/amazon\.com$/.test(host),
		};
	} catch {
		return {
			origin: "https://www.amazon.com",
			currency: "USD",
			dayFirst: false,
		};
	}
}

function orderIdIn(text: string | undefined): string | undefined {
	return text ? ORDER_ID_RE.exec(text)?.[0] : undefined;
}

function idFromHrefs($: Doc, scope: Sel | undefined): string | undefined {
	let found: string | undefined;
	findAll($, scope, 'a[href*="orderID="], a[href*="orderId="]').each(
		(_, el) => {
			if (found) return;
			const href = $(el).attr("href") ?? "";
			const id = queryParam(href, "orderID") ?? queryParam(href, "orderId");
			if (id && ORDER_ID_RE.test(id)) found = id;
		},
	);
	return found;
}

function asin(href: string | undefined): string | undefined {
	return href
		? /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?=[/?#]|$)/.exec(href)?.[1]
		: undefined;
}

const ITEM_CONTAINERS = [
	"[data-component='purchasedItems'] .a-fixed-left-grid",
	".item-box",
	".yo-enhanced-flex-card, .yo-enhanced-card",
	".itemDetails",
	".a-fixed-left-grid:has(.yohtmlc-item)",
	"div:has(> div.yohtmlc-item)",
];

function parseItems(
	$: Doc,
	scope: Sel,
	origin: string,
	currency: string | undefined,
): ParsedItem[] {
	let containers: Sel | undefined;
	for (const selector of ITEM_CONTAINERS) {
		const found = findAll($, scope, selector);
		if (found.length > 0) {
			containers = found;
			break;
		}
	}
	const items: ParsedItem[] = [];
	containers?.each((_, el) => {
		const box = $(el);
		const titleEl = pick($, box, [
			"[data-component='itemTitle'] a",
			"[data-component='itemTitle']",
			".yohtmlc-product-title a",
			".yohtmlc-product-title",
			".yohtmlc-item a.a-link-normal",
			".yo-enhanced-title a",
			"a[href*='/dp/']:not(:has(img))",
			"a[href*='/gp/product/']:not(:has(img))",
		]);
		const title =
			textOf(titleEl?.first()) || box.find("img[alt]").first().attr("alt");
		if (!title) return;
		const link =
			titleEl?.first().is("a") === true
				? titleEl.first()
				: box.find("a[href*='/dp/'], a[href*='/gp/product/']").first();
		const href = link.attr("href");
		const id =
			asin(href) ??
			asin(
				box
					.find("a[href*='/dp/'], a[href*='/gp/product/']")
					.first()
					.attr("href"),
			);
		const priceText =
			pickText($, box, [
				"[data-component='unitPrice'] .a-offscreen",
				"[data-component='unitPrice'] .a-text-price",
				"[data-component='unitPrice']",
				".a-color-price",
				".yohtmlc-item .a-color-price",
			]) ?? undefined;
		const unit = priceText ? parseMoney(priceText, { currency }) : undefined;
		const qtyText = pickText($, box, [
			"[data-component='quantity']",
			".od-item-view-qty",
			".item-view-qty",
			".product-image__qty",
			".itemQuantity",
		]);
		const quantity = Number(/(\d+)/.exec(qtyText ?? "")?.[1] ?? "1") || 1;
		const condition =
			/Condition:\s*((?:New|Used|Renewed|Refurbished|Collectible|Open box)(?:\s*[-–]\s*(?:Like New|Very Good|Good|Acceptable|Excellent|Premium))?)/i.exec(
				textOf(box),
			)?.[1];
		items.push({
			externalItemId: id,
			title,
			sku: id,
			variant:
				pickText($, box, ["[data-component='purchasedVariationDetails']"]) ??
				(condition && !/^new$/i.test(condition.trim())
					? `Condition: ${condition.trim()}`
					: undefined),
			quantity,
			unitPriceMinor: unit?.amountMinor,
			totalMinor: unit ? unit.amountMinor * quantity : undefined,
			imageUrl: imageUrl(box.find("img").first(), origin),
			itemUrl: id ? `${origin}/dp/${id}` : absUrl(href, origin),
		});
	});
	return items;
}

function sellerOf($: Doc, scope: Sel): string | undefined {
	const sellers = new Set<string>();
	findAll(
		$,
		scope,
		"[data-component='orderedMerchant'], .yohtmlc-item .a-size-small, span.a-size-small",
	).each((_, el) => {
		const text = textOf($(el));
		const m =
			/(?:Sold by|Verkauf durch|Vendu par|Vendido por)\s*:?\s*(.+?)(?:\s*(?:Return|Rückgabe|Supplied by|$))/i.exec(
				text,
			);
		if (m?.[1]) sellers.add(cleanText(m[1]));
	});
	return sellers.size === 1 ? [...sellers][0] : undefined;
}

type ChargeField =
	| "subtotalMinor"
	| "shippingMinor"
	| "taxMinor"
	| "discountMinor"
	| "totalMinor";

const CHARGE_RULES: Array<
	[RegExp, ChargeField | "skip" | "grand" | "giftcard"]
> = [
	[/refund|erstattung|rückerstattung|remboursement|reembolso/i, "skip"],
	[
		/grand total|total for this order|order total|gesamtsumme|montant total|importe total|totale ordine|\bsumme:/i,
		"grand",
	],
	[
		/gift ?card|geschenkgutschein|gutschein-guthaben|carte cadeau|tarjeta regalo/i,
		"giftcard",
	],
	[/before (tax|vat)|vor steuer|ohne mwst|avant taxes/i, "skip"],
	[
		/free (shipping|delivery)|kostenlose lieferung|livraison gratuite/i,
		"discountMinor",
	],
	[/sub-?total|zwischensumme|sous-total|subtotal/i, "subtotalMinor"],
	[
		/shipping|postage|delivery|versand|verpackung|livraison|envío|spedizione/i,
		"shippingMinor",
	],
	[/\btax|vat|gst|hst|pst|qst|mwst|ust\.|tva|iva|impuesto/i, "taxMinor"],
	[
		/promotion|coupon|discount|subscribe|savings|rabatt|reward|points|réduction|descuento|sconto|multibuy|aktion/i,
		"discountMinor",
	],
	[/^total\b|^summe|^gesamt|^total:/i, "totalMinor"],
];

function chargeRows(
	$: Doc,
	scope: Sel,
): Array<{ label: string; value: string }> {
	const rows: Array<{ label: string; value: string }> = [];
	const modern = findAll(
		$,
		scope,
		"[data-component='chargeSummary'] .od-line-item-row",
	);
	if (modern.length > 0) {
		modern.each((_, el) => {
			const row = $(el);
			rows.push({
				label: textOf(row.find(".od-line-item-row-label")),
				value: textOf(row.find(".od-line-item-row-content")),
			});
		});
		return rows;
	}
	const legacy = findAll(
		$,
		scope,
		"#od-subtotals .a-row, [data-component='orderSubtotals'] .a-row",
	).filter((_, el) => $(el).find(".a-row").length === 0);
	const seen = new Set<string>();
	legacy.each((_, el) => {
		const text = textOf($(el));
		if (seen.has(text)) return;
		seen.add(text);
		const money = findMoneyStrings(text);
		const last = money[money.length - 1];
		if (!last) return;
		rows.push({
			label: text.slice(0, text.lastIndexOf(last)),
			value: text.slice(text.lastIndexOf(last)),
		});
	});
	return rows;
}

function applyCharges(
	order: ParsedOrder,
	rows: Array<{ label: string; value: string }>,
	currency: string | undefined,
): number {
	let grand: number | undefined;
	let giftCard = 0;
	let plainTotal: number | undefined;
	let subtotalSet = false;
	for (const row of rows) {
		const rule = CHARGE_RULES.find(([re]) => re.test(row.label))?.[1];
		if (!rule || rule === "skip") continue;
		const money = parseMoney(row.value, { currency, allowFree: true });
		if (!money) continue;
		order.currency = order.currency ?? money.currency;
		if (rule === "grand") grand = grand ?? money.amountMinor;
		else if (rule === "giftcard") giftCard += Math.abs(money.amountMinor);
		else if (rule === "totalMinor")
			plainTotal = plainTotal ?? money.amountMinor;
		else if (rule === "subtotalMinor") {
			if (!subtotalSet) order.subtotalMinor = money.amountMinor;
			subtotalSet = true;
		} else if (rule === "discountMinor")
			order.discountMinor =
				(order.discountMinor ?? 0) + Math.abs(money.amountMinor);
		else order[rule] = (order[rule] ?? 0) + money.amountMinor;
	}
	// A gift card is a payment method, not a discount: "Grand Total" is what
	// was left to charge, so the order's cost is Grand Total + gift card.
	const charged = grand ?? plainTotal;
	order.totalMinor =
		charged === undefined ? order.totalMinor : charged + giftCard;
	return giftCard;
}

function paymentOf($: Doc, scope: Sel): { hint?: string; last4?: string } {
	const numberText = pickText($, scope, [
		"[data-testid='payment-instrument-number']",
	]);
	const brand =
		pickText($, scope, ["[data-testid='payment-instrument-name']"]) ??
		scope
			.find("img.pmts-payment-credit-card-instrument-logo[alt]")
			.first()
			.attr("alt") ??
		undefined;
	const block = textOf(
		pick($, scope, [
			"[data-component='viewPaymentPlanSummaryWidget']",
			".pmts-payments-instrument-list",
			".pmts-payment-instrument-billing-address",
			"[data-component='paymentMethod']",
		])?.first(),
	);
	const last4 = extractLast4(
		numberText ? `ending in ${numberText.replace(/\D/g, "").slice(-4)}` : block,
	);
	if (!last4 && !brand && !block) return {};
	const cleanBlock = block
		.replace(/^payment method\s*/i, "")
		.replace(/View related transactions.*$/i, "")
		.trim();
	const brandBeforeLast4 = last4
		? new RegExp(
				`([A-Za-z][\\w .&'-]{1,30}?)\\s+(?:ending in|endet auf|mit der Endung)\\s+${last4}`,
				"i",
			).exec(cleanBlock)?.[1]
		: undefined;
	const hint =
		brand && last4
			? `${brand} ending in ${last4}`
			: brandBeforeLast4 && last4
				? `${brandBeforeLast4.trim()} ending in ${last4}`
				: cleanBlock.slice(0, 120) || brand;
	return {
		hint: /unable to display/i.test(hint ?? "") ? undefined : hint,
		last4,
	};
}

function shipmentStatus($: Doc, scope: Sel): string | undefined {
	const texts: string[] = [];
	findAll(
		$,
		scope,
		"[data-component='shipmentStatus'] .od-status-message, h4.od-status-message, .delivery-box__primary-text, .yohtmlc-shipment-status-primaryText, .shipment-top-row .a-text-bold, .js-shipment-info-container .a-row .a-text-bold, #orderCardDeliveryBox .a-size-medium .a-text-bold",
	).each((_, el) => {
		const t = textOf($(el));
		if (t && !texts.includes(t)) texts.push(t);
	});
	return texts[0];
}

/* ------------------------------- list page ------------------------------ */

function headerValues($: Doc, card: Sel): { date?: string; total?: string } {
	const out: { date?: string; total?: string } = {};
	const items = findAll(
		$,
		card,
		".order-header__header-list-item, .order-info .a-column, .order-header .a-column, #orderCardHeader .a-column",
	);
	items.each((_, el) => {
		const lines = linesOf($(el));
		const label = (lines[0] ?? "").toLowerCase();
		const value = lines.slice(1).join(" ");
		if (!value) return;
		if (
			/order placed|bestellung aufgegeben|commande (effectuée|passée)|pedido realizado|ordine effettuato|date/.test(
				label,
			)
		)
			out.date = out.date ?? value;
		else if (/^(total|summe|gesamt|montant|importe|totale)/.test(label))
			out.total = out.total ?? value;
	});
	out.total =
		out.total ??
		pickText($, card, [
			".yohtmlc-order-total .value",
			".yohtmlc-order-total span:last-child",
		]);
	return out;
}

function parseListPage(
	$: Doc,
	input: ParserInput,
	warnings: string[],
): ParsedOrder[] {
	const { origin, currency, dayFirst } = marketplace(input.pageUrl);
	// Layouts are tried in turn: a page may carry a stray match for an older
	// selector (Amazon Business ships an empty `.js-order-card` template).
	for (const selector of LIST_CARDS) {
		const orders = parseListCards($, findAll($, undefined, selector), {
			origin,
			currency,
			dayFirst,
			warnings,
		});
		if (orders.length > 0) return orders;
	}
	return [];
}

const LIST_CARDS = [
	".order-card",
	".js-order-card",
	"div.a-box-group:has(#orderIdField)",
	"div.order",
];

function placedByGroup($: Doc, card: Sel): string | undefined {
	const visible = pickText($, card, ['[data-siege-target^="placedByGroup_"]']);
	if (visible) return visible;
	const raw = card.find('input[name="aggregatedFields"]').attr("value");
	if (!raw) return undefined;
	try {
		const fields: unknown = JSON.parse(raw);
		if (
			typeof fields === "object" &&
			fields !== null &&
			"placedByGroup" in fields &&
			typeof fields.placedByGroup === "string"
		)
			return cleanText(fields.placedByGroup) || undefined;
	} catch {
		/* A malformed optional widget must not discard the order. */
	}
	return undefined;
}

function parseListCards(
	$: Doc,
	cards: Sel,
	ctx: {
		origin: string;
		currency: string | undefined;
		dayFirst: boolean;
		warnings: string[];
	},
): ParsedOrder[] {
	const { origin, currency, dayFirst, warnings } = ctx;
	const orders: ParsedOrder[] = [];
	cards.each((_, el) => {
		const card = $(el);
		const id =
			orderIdIn(
				pickText($, card, [
					".yohtmlc-order-id [dir='ltr']",
					".yohtmlc-order-id bdi",
					".yohtmlc-order-id .value",
					"#orderIdField [dir='auto']",
				]),
			) ??
			orderIdIn(
				pickText($, card, ["[data-component='orderId']", ".yohtmlc-order-id"]),
			) ??
			idFromHrefs($, card);
		if (!id) {
			if (card.find(".csd-encrypted-sensitive").length)
				warnings.push(
					"amazon: order card still CSD-encrypted (snapshot taken before decryption)",
				);
			return;
		}
		const header = headerValues($, card);
		const total = header.total
			? parseMoney(header.total, { currency })
			: undefined;
		const statusText = shipmentStatus($, card);
		const items = parseItems($, card, origin, currency);
		orders.push({
			externalOrderId: id,
			orderUrl: `${origin}/gp/your-account/order-details?orderID=${id}`,
			orderDate: parseDate(header.date, { dayFirst }),
			placedByGroup: placedByGroup($, card),
			shipToAddress: pickText($, card, [
				'[data-siege-target^="shipToAddress_"]',
			]),
			statusText,
			status: normalizeStatus(statusText),
			currency: total?.currency ?? currency,
			totalMinor: total?.amountMinor,
			items,
			itemsPartial: true,
			documentLinks: documentLinks($, origin, card),
		});
	});
	return orders;
}

/* ------------------------ detail / invoice pages ------------------------ */

function parseDetailPage(
	$: Doc,
	input: ParserInput,
	warnings: string[],
): ParsedOrder[] {
	const { origin, currency, dayFirst } = marketplace(input.pageUrl);
	const root =
		pick($, undefined, [
			"#orderDetails",
			"#ordersContainer",
			"#odp-main-section",
		])?.first() ?? $("body");
	const id =
		orderIdIn(pickText($, root, ["[data-component='orderId']"])) ??
		orderIdIn(
			pickText($, root, [
				".order-date-invoice-item bdi[dir='ltr']",
				".order-date-invoice-item [dir='ltr']",
			]),
		) ??
		orderIdIn(pickText($, root, ["[data-component='briefOrderInfo']"])) ??
		orderIdIn(
			queryParam(input.pageUrl, "orderID") ??
				queryParam(input.pageUrl, "orderId"),
		) ??
		input.orderIdHints.find((h) => ORDER_ID_RE.test(h));
	if (!id) return [];
	const dateText =
		pickText($, root, ["[data-component='orderDate']"]) ??
		pickText($, root, [
			"span.order-date-invoice-item",
			"[data-component='briefOrderInfo']",
		]);
	const items = parseItems($, root, origin, currency);
	const payment = paymentOf($, root);
	const statusText = shipmentStatus($, root);
	const cancelled =
		textOf(root.find("[data-component='cancelled']")).length > 0 ||
		/cancel/i.test(textOf(root.find("h4.a-alert-heading")));
	const order: ParsedOrder = {
		externalOrderId: id,
		merchantName: sellerOf($, root),
		orderUrl: `${origin}/gp/your-account/order-details?orderID=${id}`,
		orderDate: parseDate(dateText, { dayFirst }),
		statusText: cancelled ? (statusText ?? "Cancelled") : statusText,
		status: cancelled ? "cancelled" : normalizeStatus(statusText),
		currency,
		paymentHint: payment.hint,
		paymentLast4: payment.last4,
		items: items.length ? items : undefined,
		documentLinks: documentLinks($, origin, root),
	};
	const giftCard = applyCharges(order, chargeRows($, root), currency);
	if (giftCard > 0)
		order.paymentHint = order.paymentHint
			? `${order.paymentHint} + gift card`
			: "Amazon gift card";
	if (order.totalMinor === undefined) {
		// Legacy printable summary: plain text tables.
		const text = linesOf(root).join("\n");
		const opts = { currency };
		order.totalMinor =
			moneyAfterLabel(
				text,
				/grand total:|order total:|gesamtsumme:|\bsumme:/i,
				opts,
			)?.amountMinor ?? order.totalMinor;
		order.subtotalMinor =
			order.subtotalMinor ??
			moneyAfterLabel(text, /item\(s\) subtotal:|zwischensumme:/i, opts)
				?.amountMinor;
		order.shippingMinor =
			order.shippingMinor ??
			moneyAfterLabel(text, /shipping & handling:|versand:/i, opts)
				?.amountMinor;
		order.taxMinor =
			order.taxMinor ??
			moneyAfterLabel(
				text,
				/estimated tax to be collected:|tax collected:|mwst\.?:|vat:/i,
				opts,
			)?.amountMinor;
		order.orderDate =
			order.orderDate ??
			parseDate(/order placed:?\s*([^\n]+)/i.exec(text)?.[1], { dayFirst });
		if (!order.paymentLast4) order.paymentLast4 = extractLast4(text);
		if (!order.items) {
			const legacy: ParsedItem[] = [];
			const lines = linesOf(root);
			lines.forEach((line, i) => {
				const m = /^(\d+)\s+of:\s*(.+)$/i.exec(line);
				if (!m) return;
				const quantity = Number(m[1]);
				const priceLine = lines
					.slice(i + 1, i + 6)
					.find((l) => findMoneyStrings(l).length > 0);
				const unit = priceLine
					? parseMoney(findMoneyStrings(priceLine)[0], opts)
					: undefined;
				legacy.push({
					title: m[2] ?? "",
					quantity,
					unitPriceMinor: unit?.amountMinor,
					totalMinor: unit ? unit.amountMinor * quantity : undefined,
				});
			});
			if (legacy.length) order.items = legacy;
		}
	}
	if (order.totalMinor === undefined)
		warnings.push("amazon: no order total found on detail page");
	return [order];
}

function looksLikeList($: Doc, input: ParserInput): boolean {
	if (input.pageType === "order_list") return true;
	if (input.pageType === "order_detail" || input.pageType === "invoice")
		return false;
	if (/order-details|summary\/print|order-summary|invoice/i.test(input.pageUrl))
		return false;
	return (
		$(".order-card, .js-order-card, #orderCard").length > 0 ||
		/your-orders\/orders|order-history/i.test(input.pageUrl)
	);
}

function parseHtml(input: ParserInput, html: string): ParseResult {
	const warnings: string[] = [];
	const $ = loadHtml(html);
	if (
		$(
			"#aa-challenge-page-captcha-container, form[action$='validateCaptcha'], script[src*='awswaf.com']",
		).length &&
		!$(".order-card, #orderDetails").length
	)
		return {
			outcome: "no_orders",
			reason: "Amazon bot challenge / captcha page",
		};
	if (
		$("form[name='signIn']").length &&
		!$(".order-card, #orderDetails").length
	)
		return { outcome: "no_orders", reason: "Amazon sign-in page" };
	const orders = looksLikeList($, input)
		? parseListPage($, input, warnings)
		: parseDetailPage($, input, warnings);
	if (orders.length === 0 && input.pageType === "order_confirmation") {
		// The thank-you page has no order id (purchaseId ≠ order id).
		const ids = new Set<string>();
		const id = idFromHrefs($, undefined);
		if (id) ids.add(id);
		if (ids.size === 0)
			return {
				outcome: "no_orders",
				reason:
					"Amazon thank-you page has no order id; capture Your Orders instead",
			};
	}
	if (orders.length === 0) {
		const fallback = genericHtmlOrders($, input, {
			allowText: false,
			currencyHint: marketplace(input.pageUrl).currency,
		});
		orders.push(
			...fallback.orders.filter((o) => ORDER_ID_RE.test(o.externalOrderId)),
		);
	}
	return buildResult(orders, warnings, "no Amazon orders found on page");
}

export const amazonParser: StoreParser = {
	source: "amazon",
	version: 4,
	parse(input) {
		return safeParse("amazon", () => {
			const { payload } = input;
			if (payload.type === "html") return parseHtml(input, payload.html);
			if (payload.type === "json")
				return {
					outcome: "no_orders",
					reason: "Amazon has no order JSON API; capture an HTML snapshot",
				};
			return {
				outcome: "unsupported",
				reason: "page_text captures go to AI extraction",
			};
		});
	},
};
