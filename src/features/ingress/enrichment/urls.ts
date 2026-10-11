/**
 * Pure helpers for enrichment: where a store's order-detail page lives and
 * whether an order still looks incomplete. No server imports (unit-tested).
 */

export type OrderUrlHints = {
	/** orders.order_url, when a parser recorded one. */
	orderUrl?: string | null;
	currency?: string | null;
};

function hostOf(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return /^https?:$/.test(parsed.protocol)
			? parsed.hostname.toLowerCase()
			: null;
	} catch {
		return null;
	}
}

/** Pick a marketplace domain: the order URL's host wins, then currency. */
function marketplace(
	hints: OrderUrlHints,
	known: readonly string[],
	byCurrency: Record<string, string>,
	fallback: string,
): string {
	const host = hostOf(hints.orderUrl);
	if (host) {
		const match = known.find((d) => host === d || host.endsWith(`.${d}`));
		if (match) return match;
	}
	const currency = hints.currency?.toUpperCase();
	return (currency && byCurrency[currency]) || fallback;
}

/** Marketplaces the extension has host permissions for (extension/src/lib/stores.ts). */
const AMAZON_DOMAINS = ["amazon.co.uk", "amazon.com", "amazon.ca", "amazon.de"];
const EBAY_DOMAINS = [
	"ebay.co.uk",
	"ebay.com.au",
	"ebay.com",
	"ebay.ca",
	"ebay.de",
];
const DIGIKEY_DOMAINS = [
	"digikey.co.uk",
	"digikey.com",
	"digikey.ca",
	"digikey.de",
];

const enc = encodeURIComponent;

/**
 * Order-detail URL the extension should fetch for (source, externalOrderId),
 * or null when the store has no stable detail URL (Mouser uses opaque `qs=`
 * tokens, so only a recorded detail URL works there).
 */
export function orderDetailUrl(
	source: string,
	externalOrderId: string,
	hints: OrderUrlHints = {},
): string | null {
	const id = externalOrderId.trim();
	if (!id) return null;
	switch (source) {
		case "amazon": {
			if (!/^(?:\d{3}|D\d{2})-\d{7}-\d{7}$/.test(id)) return null;
			const domain = marketplace(
				hints,
				AMAZON_DOMAINS,
				{ CAD: "amazon.ca", GBP: "amazon.co.uk", EUR: "amazon.de" },
				"amazon.com",
			);
			return `https://www.${domain}/gp/your-account/order-details?orderID=${enc(id)}`;
		}
		case "aliexpress":
			if (!/^\d{12,20}$/.test(id)) return null;
			return `https://www.aliexpress.com/p/order/detail.html?orderId=${id}`;
		case "alibaba":
			if (!/^\d{10,20}$/.test(id)) return null;
			return `https://biz.alibaba.com/ta/detail.htm?orderId=${id}`;
		case "ebay": {
			if (!/^[\d-]{8,30}$/.test(id)) return null;
			const domain = marketplace(
				hints,
				EBAY_DOMAINS,
				{
					CAD: "ebay.ca",
					GBP: "ebay.co.uk",
					EUR: "ebay.de",
					AUD: "ebay.com.au",
				},
				"ebay.com",
			);
			return `https://order.${domain}/ord/show?orderId=${enc(id)}`;
		}
		case "digikey": {
			if (!/^\d{6,16}$/.test(id)) return null;
			const domain = marketplace(
				hints,
				DIGIKEY_DOMAINS,
				{ CAD: "digikey.ca", GBP: "digikey.co.uk", EUR: "digikey.de" },
				"digikey.com",
			);
			return `https://www.${domain}/OrderHistory/ReviewOrder/${id}`;
		}
		case "mouser": {
			const host = hostOf(hints.orderUrl);
			return host &&
				/(^|\.)mouser\.(com|ca|co\.uk|de)$/.test(host) &&
				/orderdetail/i.test(hints.orderUrl ?? "")
				? (hints.orderUrl as string)
				: null;
		}
		default:
			return null;
	}
}

export type CompletenessInput = {
	itemCount: number;
	itemsWithoutPrice: number;
	totalMinor: number | null;
	taxMinor: number | null;
	hasPayment: boolean;
	hasInvoice: boolean;
};

/** Reasons an order still needs data; empty when it looks complete. */
export function missingParts(input: CompletenessInput): string[] {
	const out: string[] = [];
	if (input.itemCount === 0) out.push("items");
	else if (input.itemsWithoutPrice > 0) out.push("item prices");
	if (input.totalMinor === null) out.push("total");
	if (input.taxMinor === null) out.push("tax");
	if (!input.hasPayment) out.push("payment");
	if (!input.hasInvoice) out.push("invoice");
	return out;
}

export const MAX_ENRICHMENT_ATTEMPTS = 3;
/** A finished task is only reopened after this long (avoids fetch → capture → requeue loops). */
export const REQUEUE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type ExistingTask = {
	status: "pending" | "claimed" | "done" | "failed" | "skipped";
	attempts: number;
	finishedAt: Date | null;
};

/** Should an existing task be reopened for another try? */
export function shouldRequeue(task: ExistingTask, now: Date): boolean {
	if (task.status === "pending" || task.status === "claimed") return false;
	if (task.attempts >= MAX_ENRICHMENT_ATTEMPTS) return false;
	if (!task.finishedAt) return true;
	return now.getTime() - task.finishedAt.getTime() >= REQUEUE_COOLDOWN_MS;
}
