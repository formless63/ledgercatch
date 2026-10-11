import type {
	CaptureKind,
	CapturePayload,
	PageType,
	StoreId,
} from "#/shared/capture";

/** What a parser receives: the stored capture, minus server bookkeeping. */
export type ParserInput = {
	source: StoreId;
	kind: CaptureKind;
	pageType: PageType;
	pageUrl: string;
	pageTitle: string;
	capturedAt: string;
	/** Client-local date retained separately from normalized database timestamps. */
	capturedLocalDate?: string;
	orderIdHints: string[];
	payload: CapturePayload;
};

export type OrderStatus =
	| "placed"
	| "processing"
	| "shipped"
	| "delivered"
	| "cancelled"
	| "returned"
	| "unknown";

export type ParsedItem = {
	externalItemId?: string;
	title: string;
	sku?: string;
	variant?: string;
	quantity: number;
	/** Minor units in the order currency. */
	unitPriceMinor?: number;
	totalMinor?: number;
	imageUrl?: string;
	itemUrl?: string;
};

export type ParsedShipment = {
	carrier?: string;
	trackingNumber: string;
	status?: string;
	shippedAt?: string;
	deliveredAt?: string;
	etaText?: string;
};

export type ParsedDocumentLink = {
	kind: "invoice" | "receipt" | "packing_slip";
	url: string;
};

/**
 * A normalized order fragment. Parsers return whatever they can see; the
 * ingest step merges fragments for the same (source, externalOrderId), so a
 * list page can contribute totals and a detail page can contribute items.
 * Omit fields you cannot see rather than guessing; `undefined` never
 * overwrites a known value.
 */
export type ParsedOrder = {
	externalOrderId: string;
	merchantName?: string;
	orderUrl?: string;
	/** ISO date (YYYY-MM-DD). */
	orderDate?: string;
	status?: OrderStatus;
	statusText?: string;
	/** Store account business group that placed the order. */
	placedByGroup?: string;
	shipToAddress?: string;
	checkoutEmailDomain?: string;
	/** ISO-4217, upper case. */
	currency?: string;
	subtotalMinor?: number;
	shippingMinor?: number;
	taxMinor?: number;
	discountMinor?: number;
	totalMinor?: number;
	/** Free text like "Visa ending in 4821". */
	paymentHint?: string;
	paymentLast4?: string;
	/** When present, replaces the stored item list (a complete view of items). */
	items?: ParsedItem[];
	/** True when `items` is known to be partial (e.g. list page previews). */
	itemsPartial?: boolean;
	shipments?: ParsedShipment[];
	documentLinks?: ParsedDocumentLink[];
};

export type ParseResult =
	| { outcome: "orders"; orders: ParsedOrder[]; warnings: string[] }
	| { outcome: "no_orders"; reason: string }
	| { outcome: "unsupported"; reason: string };

export type StoreParser = {
	source: StoreId;
	/** Bump when output changes so captures can be re-parsed selectively. */
	version: number;
	parse(input: ParserInput): ParseResult;
};
