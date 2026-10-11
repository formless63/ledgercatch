/**
 * Store-agnostic email extraction: schema.org markup (Gmail "email markup"
 * Order / ParcelDelivery in JSON-LD or microdata) and storefront-platform /
 * visible-text heuristics for Shopify, WooCommerce and other shops.
 */
import { genericHtmlOrders, textHeuristicOrder } from "../generic";
import { extractOrderIdFromText } from "../heuristics";
import type { Doc } from "../html";
import { isRecord, type JsonRecord, unwrapBody } from "../json";
import {
	jsonLdOrders,
	microdataOrders,
	orderFromSchema,
	schemaTypes,
} from "../platforms/schema-org";
import { compact } from "../result";
import { cleanText, detectCarrier } from "../text";
import type { ParsedOrder, ParserInput } from "../types";
import {
	type EmailContext,
	itemsFromQuantityLines,
	paymentFrom,
	shipmentsFrom,
	statusForKind,
	totalsFrom,
} from "./common";
import type { EmailStoreParse } from "./stores";

function flatten(value: unknown, out: JsonRecord[] = []): JsonRecord[] {
	if (Array.isArray(value)) for (const v of value) flatten(v, out);
	else if (isRecord(value)) {
		out.push(value);
		if (value["@graph"]) flatten(value["@graph"], out);
	}
	return out;
}

function nameOf(value: unknown): string | undefined {
	if (typeof value === "string") return cleanText(value) || undefined;
	if (isRecord(value) && typeof value.name === "string")
		return cleanText(value.name) || undefined;
	return undefined;
}

/** schema.org ParcelDelivery (Gmail shipping markup) → order + shipment. */
export function parcelDeliveryOrders($: Doc, base: string): ParsedOrder[] {
	const out: ParsedOrder[] = [];
	$('script[type="application/ld+json"]').each((_, el) => {
		for (const node of flatten(unwrapBody($(el).text()))) {
			if (!schemaTypes(node).includes("ParcelDelivery")) continue;
			const part = isRecord(node.partOfOrder) ? node.partOfOrder : undefined;
			if (!part) continue;
			const order = orderFromSchema({ "@type": "Order", ...part }, base);
			if (!order) continue;
			const tracking =
				typeof node.trackingNumber === "string"
					? node.trackingNumber.trim()
					: undefined;
			const statusRaw = nameOf(node.deliveryStatus) ?? "";
			const delivered = /delivered/i.test(statusRaw);
			const carrier =
				nameOf(node.carrier) ??
				nameOf(node.provider) ??
				detectCarrier(statusRaw);
			out.push({
				...order,
				status: delivered ? "delivered" : (order.status ?? "shipped"),
				shipments: tracking
					? [
							{
								trackingNumber: tracking,
								carrier,
								etaText:
									typeof node.expectedArrivalUntil === "string"
										? node.expectedArrivalUntil
										: undefined,
							},
						]
					: order.shipments,
			});
		}
	});
	return out;
}

/** Gmail/schema.org markup orders in the email HTML (any store). */
export function structuredEmailOrders(ctx: EmailContext, base: string) {
	if (!ctx.$) return [];
	return [
		...jsonLdOrders(ctx.$, base),
		...microdataOrders(ctx.$, base),
		...parcelDeliveryOrders(ctx.$, base),
	];
}

/* ------------------------------------------------------------------------ */
/* Shop identity for unknown stores                                          */
/* ------------------------------------------------------------------------ */

/** Sending services: their domain says nothing about the shop. */
const ESP_DOMAINS =
	/(?:^|\.)(?:shopify\.com|shopifyemail\.com|myshopify\.com|mailgun\.(?:org|net)|sendgrid\.net|amazonses\.com|mcsv\.net|mcdlv\.net|mandrillapp\.com|klaviyomail\.com|klaviyo\.com|sparkpostmail\.com|postmarkapp\.com|sendinblue\.com|brevo\.com|mailchimp\.com|list-manage\.com|hubspotemail\.net|bigcommerce\.com|squarespace\.com|wix\.com|gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|yahoo\.com|icloud\.com)$/i;
const LINK_NOISE =
	/(?:^|\.)(?:facebook|instagram|twitter|x|tiktok|pinterest|youtube|linkedin|google|apple|shopify|shopifycdn|cdn|klaviyo|mailchimp|list-manage|sendgrid|mailgun|w3|schema|gravatar|wordpress|woocommerce|paypal|stripe)\.[a-z.]+$/i;

export function registrableDomain(host: string): string {
	const parts = host.toLowerCase().replace(/\.$/, "").split(".");
	if (parts.length <= 2) return parts.join(".");
	const sld = parts[parts.length - 2] ?? "";
	const tld = parts[parts.length - 1] ?? "";
	const take =
		tld.length === 2 && /^(?:co|com|org|net|ac|gov|edu|ne|or)$/.test(sld)
			? 3
			: 2;
	return parts.slice(-take).join(".");
}

function linkHosts($: Doc | undefined): Array<{ host: string; href: string }> {
	if (!$) return [];
	const out: Array<{ host: string; href: string }> = [];
	$("a[href]").each((_, el) => {
		const href = $(el).attr("href") ?? "";
		try {
			const url = new URL(href);
			if (url.protocol === "https:" || url.protocol === "http:")
				out.push({ host: url.hostname.replace(/^www\./, ""), href: url.href });
		} catch {
			// relative / mailto links carry no shop host
		}
	});
	return out;
}

const ORDER_LINK = /\/orders?\/|order[-_]?status|view[-_]?order|\/account\b/i;

/**
 * Best guess of the shop's web host and order link for an email from an
 * unknown store (so generic order ids are namespaced like page captures).
 */
export function shopIdentity(ctx: EmailContext): {
	host: string;
	orderUrl?: string;
} {
	const links = linkHosts(ctx.$);
	const sender = ctx.senderDomain;
	const senderBase =
		sender && !ESP_DOMAINS.test(sender) ? registrableDomain(sender) : undefined;
	let candidates = senderBase
		? links.filter(
				(l) => l.host === senderBase || l.host.endsWith(`.${senderBase}`),
			)
		: [];
	if (candidates.length === 0 && !senderBase) {
		const counts = new Map<string, number>();
		for (const l of links)
			if (!LINK_NOISE.test(l.host) && !ESP_DOMAINS.test(l.host))
				counts.set(l.host, (counts.get(l.host) ?? 0) + 1);
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		if (top) candidates = links.filter((l) => l.host === top);
	}
	const orderLink = candidates.find((l) => ORDER_LINK.test(l.href));
	const host =
		orderLink?.host ??
		(senderBase && candidates.some((l) => l.host === senderBase)
			? senderBase
			: candidates[0]?.host) ??
		senderBase ??
		(sender || "unknown-shop.invalid");
	return { host, orderUrl: orderLink?.href };
}

/* ------------------------------------------------------------------------ */
/* Generic chain                                                             */
/* ------------------------------------------------------------------------ */

const SUBJECT_ORDER_ID = [
	/\border\s*(?:#|no\.?|number|nr\.?)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{0,40})/i,
	/#\s*([A-Z0-9][A-Z0-9-]{1,40})\b/i,
	/\border\s+([A-Z]*\d[A-Z0-9-]{1,40})\b/i,
];

export function subjectOrderId(subject: string): string | undefined {
	for (const re of SUBJECT_ORDER_ID) {
		const m = re.exec(subject);
		const id = m?.[1]?.replace(/-+$/, "");
		if (id && /\d/.test(id)) return id;
	}
	return undefined;
}

function platformOf(html: string | undefined): string | undefined {
	if (!html) return undefined;
	if (/cdn\.shopify\.com|shopify/i.test(html)) return "shopify";
	if (/woocommerce|wc-email|template_container/i.test(html))
		return "woocommerce";
	return undefined;
}

/**
 * Shopify / WooCommerce / any shop: storefront platform markup and
 * schema.org via the generic page parser, then visible-text heuristics with
 * the subject's order number as a hint (Woo's "Order #42" is too short for
 * the page heuristics on its own).
 */
export function genericEmailOrders(ctx: EmailContext): EmailStoreParse {
	const shop = shopIdentity(ctx);
	const pageUrl = shop.orderUrl ?? `https://${shop.host}/`;
	const subjectId = subjectOrderId(ctx.subject);
	const bodyId =
		extractOrderIdFromText(ctx.flat) ??
		/\border\s*#\s*([A-Z0-9][A-Z0-9-]{0,40})/i.exec(ctx.flat)?.[1];
	const id = subjectId ?? bodyId;
	const merchant = ctx.email.from?.name
		? cleanText(
				ctx.email.from.name.replace(/\b(?:orders?|no-?reply|team)\b/gi, ""),
			)
		: undefined;
	const input: ParserInput = {
		source: "generic",
		kind: "html_snapshot",
		pageType: ctx.kind === "confirmation" ? "order_confirmation" : "unknown",
		pageUrl,
		pageTitle: ctx.subject,
		capturedAt: ctx.email.date ?? new Date(0).toISOString(),
		orderIdHints: id ? [id] : [],
		payload: { type: "html", html: ctx.email.html ?? "" },
	};
	const warnings: string[] = [];
	const platform = platformOf(ctx.email.html);
	const withShop = (o: ParsedOrder): ParsedOrder => ({
		...o,
		merchantName:
			o.merchantName && o.merchantName !== shop.host
				? o.merchantName
				: (merchant ?? o.merchantName ?? shop.host),
		orderUrl: o.orderUrl ?? pageUrl,
		orderDate:
			o.orderDate ?? (ctx.kind === "confirmation" ? ctx.emailDate : undefined),
		status: o.status ?? statusForKind(ctx.kind),
	});

	if (ctx.$) {
		const found = genericHtmlOrders(ctx.$, input, {
			html: ctx.email.html,
			allowText: false,
			platforms: true,
		});
		if (found.orders.length)
			return {
				orders: found.orders.map(withShop),
				warnings: [
					...found.warnings,
					`generic-email: ${found.platform ?? "structured"}`,
				],
			};
	}

	if (!id)
		return {
			orders: [],
			warnings,
			reason: "no order number in subject or body",
		};
	const totals = totalsFrom(ctx);
	const heuristic = textHeuristicOrder(ctx.lines, input, totals.currency);
	const fromText: ParsedOrder | undefined = heuristic.order
		? { ...heuristic.order, externalOrderId: id }
		: totals.totalMinor !== undefined && ctx.kind === "confirmation"
			? { externalOrderId: id, ...totals }
			: undefined;
	if (fromText) {
		const items = itemsFromQuantityLines(ctx.lines, {
			currency: fromText.currency ?? totals.currency,
			stopAt: /^(?:sub\s*-?total|order summary|payment|customer information)/i,
		});
		warnings.push(
			`generic-email: ${platform ?? "text"} heuristics — verify amounts`,
		);
		return {
			orders: [
				withShop({
					...compact(totals),
					...compact(fromText),
					...paymentFrom(ctx),
					items: items.length ? items : undefined,
					shipments: shipmentsFrom(ctx),
				}),
			],
			warnings,
		};
	}
	// Shipping/delivery notices: id + tracking/status is still useful.
	if (ctx.kind !== "confirmation" && ctx.kind !== "other") {
		const shipments = shipmentsFrom(ctx);
		return {
			orders: [withShop({ externalOrderId: id, shipments })],
			warnings: ["generic-email: status update only"],
		};
	}
	return {
		orders: [],
		warnings,
		reason: heuristic.reason ?? "no order total found",
	};
}
