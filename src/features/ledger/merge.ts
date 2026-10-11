import type { OrderStatus, ParsedOrder } from "#/features/parsing/types";

/** Columns a parsed fragment may update on `orders`. */
export type OrderPatch = Partial<{
	merchantName: string;
	orderUrl: string;
	orderDate: string;
	status: OrderStatus;
	statusText: string;
	placedByGroup: string;
	shipToAddress: string;
	checkoutEmailDomain: string;
	currency: string;
	subtotalMinor: number;
	shippingMinor: number;
	taxMinor: number;
	discountMinor: number;
	totalMinor: number;
	paymentHint: string;
}>;

const STATUS_RANK: Record<OrderStatus, number> = {
	unknown: 0,
	placed: 1,
	processing: 2,
	shipped: 3,
	delivered: 4,
	returned: 5,
	cancelled: 5,
};

type ExistingOrderFields = {
	status: OrderStatus;
	currency: string | null;
};

/**
 * Builds the column patch for an existing order from a parsed fragment.
 * Unknown values never overwrite known ones; status only moves forward unless
 * the newer capture reports cancelled/returned; currency is fixed once known.
 */
export function buildOrderPatch(
	existing: ExistingOrderFields | null,
	parsed: ParsedOrder,
): OrderPatch {
	const patch: OrderPatch = {};
	const assign = <K extends keyof OrderPatch>(
		key: K,
		value: OrderPatch[K] | undefined,
	) => {
		if (value !== undefined && value !== null && value !== "")
			patch[key] = value;
	};
	assign("merchantName", parsed.merchantName?.trim());
	assign("orderUrl", parsed.orderUrl);
	assign("orderDate", parsed.orderDate);
	assign("statusText", parsed.statusText?.trim());
	assign("placedByGroup", parsed.placedByGroup?.trim());
	assign("shipToAddress", parsed.shipToAddress?.trim());
	assign(
		"checkoutEmailDomain",
		parsed.checkoutEmailDomain?.trim().toLowerCase(),
	);
	assign("paymentHint", parsed.paymentHint?.trim());

	const currency = parsed.currency?.toUpperCase();
	const currencyCompatible =
		!existing?.currency || !currency || existing.currency === currency;
	if (!existing?.currency) assign("currency", currency);
	if (currencyCompatible) {
		assign("subtotalMinor", parsed.subtotalMinor);
		assign("shippingMinor", parsed.shippingMinor);
		assign("taxMinor", parsed.taxMinor);
		assign("discountMinor", parsed.discountMinor);
		assign("totalMinor", parsed.totalMinor);
	}

	if (parsed.status && parsed.status !== "unknown") {
		const current = existing?.status ?? "unknown";
		if (STATUS_RANK[parsed.status] >= STATUS_RANK[current])
			patch.status = parsed.status;
	}
	return patch;
}

/** Whether parsed items should replace the stored item list. */
export function shouldReplaceItems(
	parsed: ParsedOrder,
	existingItemCount: number,
): boolean {
	if (!parsed.items || parsed.items.length === 0) return false;
	if (!parsed.itemsPartial) return true;
	return existingItemCount === 0;
}

/** Denormalized text used for full-text search. */
export function itemsSearchText(
	items: Array<{ title: string; sku?: string | null }>,
): string {
	return items
		.map((item) => [item.title, item.sku].filter(Boolean).join(" "))
		.join(" · ")
		.slice(0, 8000);
}
