/**
 * Pure helpers for item search and price history (#5, #16): normalize titles
 * into a stable grouping key and summarize purchases of the same thing.
 */

const STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"of",
	"the",
	"with",
	"to",
	"in",
	"on",
	"by",
	"new",
	"free",
	"shipping",
	"hot",
	"sale",
	"original",
	"genuine",
	"high",
	"quality",
	"pcs",
	"pc",
	"lot",
	"set",
	"pack",
]);

/** Lowercase, strip punctuation and marketing noise, keep order of the rest. */
export function normalizeTitle(title: string): string {
	return title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\[[^\]]*\]|【[^】]*】/g, " ")
		.replace(/[^\p{L}\p{N}.]+/gu, " ")
		.split(" ")
		.map((w) => w.replace(/^\.+|\.+$/g, ""))
		.filter((w) => w.length > 0 && !STOPWORDS.has(w))
		.filter((w) => !/^\d+(pcs|pc|x)$/.test(w) && !/^x\d+$/.test(w))
		.join(" ")
		.trim();
}

/** Significant title tokens (for overlap and SQL prefilters). */
export function titleTokens(title: string): string[] {
	return [
		...new Set(
			normalizeTitle(title)
				.split(" ")
				.filter((w) => w.length >= 2),
		),
	];
}

export function normalizeSku(sku: string | null | undefined): string | null {
	const cleaned = (sku ?? "").toUpperCase().replace(/[\s\-_./]+/g, "");
	return cleaned.length >= 3 ? cleaned : null;
}

/**
 * Grouping key: SKU/MPN when present, otherwise a title fingerprint (first 8
 * significant tokens). Variants stay together; they usually differ in price
 * only marginally and users search by product, not color.
 */
export function itemKey(item: { title: string; sku?: string | null }): string {
	const sku = normalizeSku(item.sku);
	if (sku) return `sku:${sku}`;
	return `t:${normalizeTitle(item.title).split(" ").slice(0, 8).join(" ")}`;
}

/** Jaccard overlap of significant tokens, 0..1. */
export function titleSimilarity(a: string, b: string): number {
	const ta = new Set(titleTokens(a));
	const tb = new Set(titleTokens(b));
	if (ta.size === 0 || tb.size === 0) return 0;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	return inter / (ta.size + tb.size - inter);
}

export type PurchaseRow = {
	itemId: string;
	orderId: string;
	title: string;
	sku: string | null;
	variant: string | null;
	quantity: number;
	unitPriceMinor: number | null;
	totalMinor: number | null;
	itemUrl: string | null;
	imageUrl: string | null;
	source: string;
	merchantName: string | null;
	orderDate: string | null;
	currency: string | null;
	externalOrderId: string;
};

/** Unit price even when the store only showed a line total. */
export function unitPrice(row: {
	unitPriceMinor: number | null;
	totalMinor: number | null;
	quantity: number;
}): number | null {
	if (row.unitPriceMinor != null) return row.unitPriceMinor;
	if (row.totalMinor != null && row.quantity > 0)
		return Math.round(row.totalMinor / row.quantity);
	return null;
}

export type ItemGroup = {
	key: string;
	title: string;
	sku: string | null;
	imageUrl: string | null;
	purchases: number;
	totalQuantity: number;
	stores: string[];
	currency: string | null;
	lastPurchaseDate: string | null;
	lastUnitPriceMinor: number | null;
	minUnitPriceMinor: number | null;
	maxUnitPriceMinor: number | null;
	/** Most recent item_url, for reorder. */
	reorderUrl: string | null;
	/** Mean days between purchases (≥3 purchases), for "reorder every ~N days". */
	cadenceDays: number | null;
	rows: PurchaseRow[];
};

const byDateDesc = (a: PurchaseRow, b: PurchaseRow) =>
	(b.orderDate ?? "").localeCompare(a.orderDate ?? "");

export function daysBetween(a: string, b: string): number {
	return Math.round(
		(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
	);
}

/** Group purchase rows by itemKey, newest group first. */
export function groupPurchases(rows: PurchaseRow[]): ItemGroup[] {
	const groups = new Map<string, PurchaseRow[]>();
	for (const row of rows) {
		const key = itemKey(row);
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const out: ItemGroup[] = [];
	for (const [key, list] of groups) {
		const sorted = [...list].sort(byDateDesc);
		const latest = sorted[0] as PurchaseRow;
		// Price stats in the dominant (latest) currency only.
		const currency = latest.currency;
		const prices = sorted
			.filter((r) => r.currency === currency)
			.map(unitPrice)
			.filter((p): p is number => p != null);
		const dates = [
			...new Set(sorted.map((r) => r.orderDate).filter(Boolean)),
		].sort() as string[];
		let cadenceDays: number | null = null;
		if (dates.length >= 3) {
			const first = dates[0] as string;
			const last = dates.at(-1) as string;
			cadenceDays = Math.round(daysBetween(first, last) / (dates.length - 1));
		}
		out.push({
			key,
			title: latest.title,
			sku: latest.sku,
			imageUrl: sorted.find((r) => r.imageUrl)?.imageUrl ?? null,
			purchases: new Set(sorted.map((r) => r.orderId)).size,
			totalQuantity: sorted.reduce((s, r) => s + (r.quantity || 0), 0),
			stores: [...new Set(sorted.map((r) => r.source))],
			currency,
			lastPurchaseDate: latest.orderDate,
			lastUnitPriceMinor: unitPrice(latest),
			minUnitPriceMinor: prices.length ? Math.min(...prices) : null,
			maxUnitPriceMinor: prices.length ? Math.max(...prices) : null,
			reorderUrl: sorted.find((r) => r.itemUrl)?.itemUrl ?? null,
			cadenceDays,
			rows: sorted,
		});
	}
	return out.sort((a, b) =>
		(b.lastPurchaseDate ?? "").localeCompare(a.lastPurchaseDate ?? ""),
	);
}

export type PricePoint = {
	date: string;
	unitPriceMinor: number;
	source: string;
	orderId: string;
};

/** Chronological unit-price series per store (one currency). */
export function priceSeries(
	rows: PurchaseRow[],
	currency: string | null,
): Map<string, PricePoint[]> {
	const out = new Map<string, PricePoint[]>();
	const sorted = [...rows]
		.filter((r) => r.orderDate && r.currency === currency)
		.sort((a, b) => (a.orderDate ?? "").localeCompare(b.orderDate ?? ""));
	for (const row of sorted) {
		const price = unitPrice(row);
		if (price == null || !row.orderDate) continue;
		out.set(row.source, [
			...(out.get(row.source) ?? []),
			{
				date: row.orderDate,
				unitPriceMinor: price,
				source: row.source,
				orderId: row.orderId,
			},
		]);
	}
	return out;
}

/** Escape LIKE metacharacters for a user-supplied fragment. */
export function likeEscape(fragment: string): string {
	return fragment.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Split a search string into ILIKE terms (max 6, ≥2 chars each). */
export function searchTerms(query: string): string[] {
	return [
		...new Set(
			query
				.toLowerCase()
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length >= 2),
		),
	].slice(0, 6);
}
