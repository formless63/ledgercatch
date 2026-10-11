/**
 * schema.org Order / Invoice extraction: JSON-LD blocks, microdata and plain
 * JSON nodes. Platform-agnostic structured data (common on email-markup
 * style receipts and some themes' confirmation pages).
 */
import { parseDate } from "../dates";
import { absUrl, type Doc, findAll, textOf } from "../html";
import {
	isRecord,
	type JsonRecord,
	num,
	oneOrMany,
	str,
	unwrapBody,
} from "../json";
import { normalizeCurrencyCode, parseMoney, toMinor } from "../money";
import { normalizeStatus } from "../status";
import { cleanText, extractLast4 } from "../text";
import type {
	OrderStatus,
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
} from "../types";

export function schemaTypes(node: JsonRecord): string[] {
	const t = node["@type"] ?? node.type;
	const list = Array.isArray(t) ? t : [t];
	return list
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.replace(/^https?:\/\/schema\.org\//i, ""));
}

const SCHEMA_STATUS: Record<string, OrderStatus> = {
	OrderCancelled: "cancelled",
	OrderDelivered: "delivered",
	OrderInTransit: "shipped",
	OrderPaymentDue: "placed",
	OrderPickupAvailable: "shipped",
	OrderProblem: "unknown",
	OrderProcessing: "processing",
	OrderReturned: "returned",
};

function nameOf(value: unknown): string | undefined {
	if (typeof value === "string") return str(value);
	if (Array.isArray(value)) return nameOf(value[0]);
	if (isRecord(value)) return str(value.name) ?? str(value.legalName);
	return undefined;
}

function urlOf(value: unknown, base: string): string | undefined {
	if (typeof value === "string") return absUrl(value, base);
	if (Array.isArray(value)) return urlOf(value[0], base);
	if (isRecord(value)) return urlOf(value.url ?? value.contentUrl, base);
	return undefined;
}

/** Price-ish value (number, string, PriceSpecification, MonetaryAmount). */
function priceOf(
	value: unknown,
	currencyHint: string | undefined,
): { minor?: number; currency?: string } {
	if (value === undefined || value === null) return {};
	if (Array.isArray(value)) return priceOf(value[0], currencyHint);
	if (isRecord(value)) {
		const currency =
			normalizeCurrencyCode(str(value.priceCurrency) ?? str(value.currency)) ??
			currencyHint;
		return priceOf(value.price ?? value.value ?? value.amount, currency);
	}
	if (typeof value === "number")
		return { minor: toMinor(value, currencyHint), currency: currencyHint };
	const text = str(value);
	if (!text) return {};
	if (/^-?\d+(\.\d+)?$/.test(text))
		return { minor: toMinor(text, currencyHint), currency: currencyHint };
	const parsed = parseMoney(text, { currency: currencyHint });
	return parsed ? { minor: parsed.amountMinor, currency: parsed.currency } : {};
}

function schemaItems(
	order: JsonRecord,
	currency: string | undefined,
	base: string,
): ParsedItem[] {
	const items: ParsedItem[] = [];
	for (const offer of oneOrMany(order.acceptedOffer ?? [])) {
		const product = isRecord(offer.itemOffered) ? offer.itemOffered : offer;
		const qty = isRecord(offer.eligibleQuantity)
			? num(offer.eligibleQuantity.value)
			: num(offer.eligibleQuantity);
		const price = priceOf(offer.price ?? offer.priceSpecification, currency);
		const quantity = qty ?? 1;
		items.push({
			title: nameOf(product) ?? "",
			sku: str(product.sku) ?? str(product.productID) ?? str(product.mpn),
			quantity,
			unitPriceMinor: price.minor,
			totalMinor:
				price.minor === undefined ? undefined : price.minor * quantity,
			imageUrl: urlOf(product.image, base),
			itemUrl: urlOf(product.url, base),
		});
	}
	for (const line of oneOrMany(order.orderedItem ?? [])) {
		const product = isRecord(line.orderedItem) ? line.orderedItem : line;
		const quantity =
			num(line.orderQuantity) ??
			(isRecord(line.orderQuantity)
				? num(line.orderQuantity.value)
				: undefined) ??
			1;
		const price = priceOf(
			product.offers ?? product.price ?? line.price,
			currency,
		);
		items.push({
			externalItemId: str(line.orderItemNumber),
			title: nameOf(product) ?? "",
			sku: str(product.sku) ?? str(product.productID),
			quantity,
			unitPriceMinor: price.minor,
			totalMinor:
				price.minor === undefined ? undefined : price.minor * quantity,
			imageUrl: urlOf(product.image, base),
			itemUrl: urlOf(product.url, base),
		});
	}
	return items.filter((i) => i.title);
}

function schemaShipments(order: JsonRecord): ParsedShipment[] {
	const out: ParsedShipment[] = [];
	for (const d of oneOrMany(order.orderDelivery ?? [])) {
		const tracking = str(d.trackingNumber);
		if (!tracking) continue;
		out.push({
			trackingNumber: tracking,
			carrier: nameOf(d.carrier ?? d.provider),
			status: str(d.deliveryStatus) ?? nameOf(d.deliveryStatus),
			etaText: str(d.expectedArrivalUntil) ?? str(d.expectedArrivalFrom),
		});
	}
	return out;
}

/** Maps a schema.org Order (or Invoice) node to a ParsedOrder. */
export function orderFromSchema(
	node: JsonRecord,
	base: string,
): ParsedOrder | undefined {
	const t = schemaTypes(node);
	if (t.includes("Invoice")) {
		const referenced = oneOrMany(node.referencesOrder ?? [])[0];
		const fromOrder = referenced
			? orderFromSchema({ "@type": "Order", ...referenced }, base)
			: undefined;
		const id =
			fromOrder?.externalOrderId ??
			str(node.confirmationNumber) ??
			str(node.identifier) ??
			str(node.accountId);
		if (!id) return undefined;
		const total = priceOf(
			node.totalPaymentDue ?? node.minimumPaymentDue,
			undefined,
		);
		const url = urlOf(node.url, base);
		return {
			...fromOrder,
			externalOrderId: id,
			merchantName:
				fromOrder?.merchantName ?? nameOf(node.provider ?? node.broker),
			currency: fromOrder?.currency ?? total.currency,
			totalMinor: fromOrder?.totalMinor ?? total.minor,
			orderDate: fromOrder?.orderDate ?? parseDate(str(node.paymentDueDate)),
			documentLinks: url
				? [{ kind: "invoice", url }]
				: fromOrder?.documentLinks,
		};
	}
	const id =
		str(node.orderNumber) ??
		str(node.confirmationNumber) ??
		str(node.identifier);
	if (!id) return undefined;
	let currency = normalizeCurrencyCode(str(node.priceCurrency));
	const total = priceOf(
		node.totalPaymentDue ?? node.price ?? node.totalPrice,
		currency,
	);
	currency = currency ?? total.currency;
	const statusRaw = str(node.orderStatus) ?? nameOf(node.orderStatus);
	const statusKey = statusRaw?.replace(/^https?:\/\/schema\.org\//i, "");
	const items = schemaItems(node, currency, base);
	const payment = nameOf(node.paymentMethod) ?? str(node.paymentMethodId);
	const discount = priceOf(node.discount, currency);
	return {
		externalOrderId: id,
		merchantName: nameOf(node.seller ?? node.merchant ?? node.broker),
		orderUrl: urlOf(node.url, base),
		orderDate: parseDate(str(node.orderDate)),
		status: statusKey
			? (SCHEMA_STATUS[statusKey] ?? normalizeStatus(statusKey))
			: undefined,
		statusText: statusKey,
		currency,
		totalMinor: total.minor,
		discountMinor: discount.minor,
		paymentHint: payment?.replace(
			/^https?:\/\/purl\.org\/goodrelations\/v1#/i,
			"",
		),
		paymentLast4: extractLast4(str(node.paymentMethodId) ?? payment),
		items: items.length ? items : undefined,
		shipments: schemaShipments(node),
	};
}

function flattenLd(value: unknown, out: JsonRecord[] = []): JsonRecord[] {
	if (Array.isArray(value)) for (const v of value) flattenLd(v, out);
	else if (isRecord(value)) {
		out.push(value);
		if (value["@graph"]) flattenLd(value["@graph"], out);
		if (value.mainEntity) flattenLd(value.mainEntity, out);
	}
	return out;
}

export function jsonLdOrders($: Doc, base: string): ParsedOrder[] {
	const out: ParsedOrder[] = [];
	$('script[type="application/ld+json"]').each((_, el) => {
		const parsed = unwrapBody($(el).text());
		for (const node of flattenLd(parsed)) {
			const t = schemaTypes(node);
			if (!t.includes("Order") && !t.includes("Invoice")) continue;
			const order = orderFromSchema(node, base);
			if (order) out.push(order);
		}
	});
	return out;
}

/* ------------------------------------------------------------------------ */
/* Microdata                                                                 */
/* ------------------------------------------------------------------------ */

function propValue(el: ReturnType<Doc>): string | undefined {
	const content = el.attr("content") ?? el.attr("datetime") ?? el.attr("value");
	if (content) return cleanText(content);
	if (el.is("a,link")) return el.attr("href");
	if (el.is("img")) return el.attr("src");
	return textOf(el) || undefined;
}

export function microdataOrders($: Doc, base: string): ParsedOrder[] {
	const out: ParsedOrder[] = [];
	findAll(
		$,
		undefined,
		'[itemscope][itemtype*="schema.org/Order"], [itemscope][itemtype*="schema.org/Invoice"]',
	).each((_, el) => {
		const scope = $(el);
		const own = (name: string) => {
			const found = scope.find(`[itemprop~="${name}"]`).filter((_, p) => {
				const owner = $(p).parent().closest("[itemscope]");
				return owner.length > 0 && owner.get(0) === el;
			});
			return found.length ? propValue(found.first()) : undefined;
		};
		const node: JsonRecord = {
			"@type": /Invoice/.test(scope.attr("itemtype") ?? "")
				? "Invoice"
				: "Order",
			orderNumber: own("orderNumber"),
			confirmationNumber: own("confirmationNumber"),
			orderDate: own("orderDate"),
			orderStatus: own("orderStatus"),
			priceCurrency: own("priceCurrency"),
			price: own("price") ?? own("totalPaymentDue"),
			paymentMethod: own("paymentMethod"),
			url: own("url"),
		};
		const offers: JsonRecord[] = [];
		scope
			.find('[itemprop~="acceptedOffer"], [itemprop~="orderedItem"]')
			.each((_, o) => {
				const offer = $(o);
				const get = (name: string) => {
					const f = offer.find(`[itemprop~="${name}"]`).first();
					return f.length ? propValue(f) : undefined;
				};
				offers.push({
					itemOffered: {
						name: get("name"),
						sku: get("sku"),
						url: get("url"),
						image: get("image"),
					},
					price: get("price"),
					priceCurrency: get("priceCurrency"),
					eligibleQuantity: get("value") ?? get("orderQuantity"),
				});
			});
		if (offers.length) node.acceptedOffer = offers;
		const order = orderFromSchema(node, base);
		if (order) out.push(order);
	});
	return out;
}
