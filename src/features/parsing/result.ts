import { parseDate } from "./dates";
import { carrierForTrackingNumber, detectCarrier } from "./text";
import type {
	ParsedDocumentLink,
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
	ParseResult,
} from "./types";

function isBlank(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		(typeof value === "string" && value.trim() === "") ||
		(typeof value === "number" && !Number.isFinite(value))
	);
}

/** Removes undefined/null/blank keys (shallow). */
export function compact<T extends object>(value: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) if (!isBlank(v)) out[key] = v;
	return out as T;
}

function intOrUndefined(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.round(value)
		: undefined;
}

export function cleanItem(item: ParsedItem): ParsedItem | undefined {
	const title = item.title?.replace(/\s+/g, " ").trim();
	if (!title) return undefined;
	const quantity =
		typeof item.quantity === "number" &&
		Number.isFinite(item.quantity) &&
		item.quantity > 0
			? item.quantity
			: 1;
	return compact({
		...item,
		title: title.slice(0, 500),
		quantity,
		unitPriceMinor: intOrUndefined(item.unitPriceMinor),
		totalMinor: intOrUndefined(item.totalMinor),
		sku: item.sku?.trim(),
		variant: item.variant?.replace(/\s+/g, " ").trim(),
	});
}

/** "Delivered on Fri, Aug 14, 2026" → 2026-08-14 when the event matches. */
function eventDate(
	status: string | undefined,
	event: RegExp,
): string | undefined {
	const m = status ? event.exec(status) : null;
	return m?.[1] ? parseDate(m[1].replace(/^[A-Za-z]{3,9},\s*/, "")) : undefined;
}

/** Fills carrier and dates a store only exposes inside other fields. */
function enrichShipment(s: ParsedShipment): ParsedShipment {
	return compact({
		...s,
		carrier:
			s.carrier ??
			carrierForTrackingNumber(s.trackingNumber) ??
			detectCarrier(s.status),
		deliveredAt:
			s.deliveredAt ?? eventDate(s.status, /\bdelivered\s+(?:on\s+)?(.+)$/i),
		shippedAt:
			s.shippedAt ?? eventDate(s.status, /\bshipped\s+(?:on\s+)?(.+)$/i),
	});
}

function dedupeShipments(list: ParsedShipment[]): ParsedShipment[] {
	const byNumber = new Map<string, ParsedShipment>();
	for (const s of list) {
		const key = s.trackingNumber?.replace(/\s+/g, "").toUpperCase();
		if (!key) continue;
		const prev = byNumber.get(key);
		byNumber.set(
			key,
			prev
				? { ...compact(s), ...compact(prev) }
				: { ...compact(s), trackingNumber: key },
		);
	}
	return [...byNumber.values()].map(enrichShipment);
}

function dedupeLinks(list: ParsedDocumentLink[]): ParsedDocumentLink[] {
	const seen = new Set<string>();
	const out: ParsedDocumentLink[] = [];
	for (const link of list) {
		if (!link.url || seen.has(link.url)) continue;
		seen.add(link.url);
		out.push(link);
	}
	return out;
}

/** Normalizes one order fragment; returns undefined when it has no id. */
export function cleanOrder(order: ParsedOrder): ParsedOrder | undefined {
	const id = order.externalOrderId?.replace(/\s+/g, "").trim();
	if (!id) return undefined;
	const items = order.items
		?.map(cleanItem)
		.filter((i): i is ParsedItem => Boolean(i));
	const shipments = order.shipments
		? dedupeShipments(order.shipments)
		: undefined;
	const documentLinks = order.documentLinks
		? dedupeLinks(order.documentLinks)
		: undefined;
	const discount = intOrUndefined(order.discountMinor);
	return compact({
		...order,
		externalOrderId: id,
		currency: order.currency?.toUpperCase(),
		subtotalMinor: intOrUndefined(order.subtotalMinor),
		shippingMinor: intOrUndefined(order.shippingMinor),
		taxMinor: intOrUndefined(order.taxMinor),
		discountMinor: discount === undefined ? undefined : Math.abs(discount),
		totalMinor: intOrUndefined(order.totalMinor),
		items: items && items.length > 0 ? items : undefined,
		itemsPartial:
			items && items.length > 0 ? order.itemsPartial || undefined : undefined,
		shipments: shipments && shipments.length > 0 ? shipments : undefined,
		documentLinks:
			documentLinks && documentLinks.length > 0 ? documentLinks : undefined,
		merchantName: order.merchantName?.replace(/\s+/g, " ").trim(),
		statusText: order.statusText?.replace(/\s+/g, " ").trim(),
		paymentHint: order.paymentHint?.replace(/\s+/g, " ").trim(),
	});
}

/** Merges two fragments of the same order seen in one capture (a wins). */
export function mergeOrder(a: ParsedOrder, b: ParsedOrder): ParsedOrder {
	const merged: ParsedOrder = { ...compact(b), ...compact(a) };
	const aItems = a.items ?? [];
	const bItems = b.items ?? [];
	if (aItems.length || bItems.length) {
		const aFull = aItems.length > 0 && !a.itemsPartial;
		const bFull = bItems.length > 0 && !b.itemsPartial;
		if (aFull || (!bFull && aItems.length >= bItems.length)) {
			merged.items = aItems;
			merged.itemsPartial = a.itemsPartial;
		} else {
			merged.items = bItems;
			merged.itemsPartial = b.itemsPartial;
		}
	}
	const shipments = [...(a.shipments ?? []), ...(b.shipments ?? [])];
	if (shipments.length) merged.shipments = shipments;
	const docs = [...(a.documentLinks ?? []), ...(b.documentLinks ?? [])];
	if (docs.length) merged.documentLinks = docs;
	return merged;
}

/**
 * Final step for every parser: cleans fragments, merges duplicates by id and
 * picks the right outcome. Fragments that carry nothing but an id are dropped.
 */
export function buildResult(
	orders: ParsedOrder[],
	warnings: string[],
	emptyReason: string,
): ParseResult {
	const byId = new Map<string, ParsedOrder>();
	for (const raw of orders) {
		const order = cleanOrder(raw);
		if (!order) continue;
		const prev = byId.get(order.externalOrderId);
		byId.set(order.externalOrderId, prev ? mergeOrder(prev, order) : order);
	}
	const final = [...byId.values()]
		.map(cleanOrder)
		.filter((o): o is ParsedOrder => Boolean(o))
		.filter((o) => Object.keys(o).length > 1);
	if (final.length === 0) return { outcome: "no_orders", reason: emptyReason };
	return { outcome: "orders", orders: final, warnings: [...new Set(warnings)] };
}

/**
 * Wraps a parser body so an unexpected exception never escapes. It is
 * reported as `unsupported` (capture marked failed with the message) rather
 * than `no_orders`, so parser bugs stay visible.
 */
export function safeParse(label: string, fn: () => ParseResult): ParseResult {
	try {
		return fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			outcome: "unsupported",
			reason: `${label} parser error: ${message}`,
		};
	}
}
