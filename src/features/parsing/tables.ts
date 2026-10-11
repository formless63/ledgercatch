import { absUrl, type Doc, findAll, imageUrl, type Sel, textOf } from "./html";
import { parseMoney } from "./money";
import type { ParsedItem } from "./types";

type ColumnKey = "qty" | "title" | "sku" | "mpn" | "unit" | "total";

const HEADER_RULES: Array<[RegExp, ColumnKey]> = [
	[/\b(qty|quantity|menge|anzahl|quantité|cantidad|ordered)\b/i, "qty"],
	[
		/unit\s*price|price\s*each|each|stückpreis|einzelpreis|prix unitaire|^price$|^unit$/i,
		"unit",
	],
	[
		/ext(\.|ended)?\s*price|line\s*total|^total|amount|gesamt|subtotal/i,
		"total",
	],
	[/mfr\.?\s*(part|no|#)|manufacturer\s*part|mpn|hersteller/i, "mpn"],
	[
		/part\s*(number|no\.?|#)|sku|item\s*(number|no\.?|#)|mouser\s*(no|#)|digi-?key\s*(part|#)|product\s*(number|no|id)|artikelnummer/i,
		"sku",
	],
	[/description|product|item|name|beschreibung|artikel|désignation/i, "title"],
];

function columnMap(headers: string[]): Map<ColumnKey, number> {
	const map = new Map<ColumnKey, number>();
	headers.forEach((header, index) => {
		const rule = HEADER_RULES.find(([re]) => re.test(header));
		if (rule && !map.has(rule[1])) map.set(rule[1], index);
	});
	return map;
}

/**
 * Line items from any table whose header names a quantity plus a description
 * or part number column (DigiKey/Mouser/Alibaba style order tables).
 */
export function tableItems(
	$: Doc,
	scope: Sel | undefined,
	base: string,
	currency: string | undefined,
): ParsedItem[] {
	const items: ParsedItem[] = [];
	findAll($, scope, "table").each((_, tableEl) => {
		const table = $(tableEl);
		if (table.find("table").length) return; // only leaf tables
		const headerRow = table.find("thead tr").first().length
			? table.find("thead tr").first()
			: table.find("tr").first();
		const headers = headerRow
			.find("th, td")
			.toArray()
			.map((c) => textOf($(c)));
		const cols = columnMap(headers);
		if (
			!cols.has("qty") ||
			!(cols.has("title") || cols.has("sku") || cols.has("mpn"))
		)
			return;
		const rows = table.find("tbody tr").length
			? table.find("tbody tr")
			: table.find("tr").slice(1);
		rows.each((_, rowEl) => {
			const row = $(rowEl);
			if (row.is(headerRow)) return;
			const cells = row.find("td");
			if (cells.length < 2) return;
			const cell = (key: ColumnKey) => {
				const index = cols.get(key);
				return index === undefined ? undefined : cells.eq(index);
			};
			const qtyText = textOf(cell("qty"));
			const quantity = Number(
				/(\d[\d,]*)/.exec(qtyText)?.[1]?.replace(/,/g, "") ?? "",
			);
			if (!Number.isFinite(quantity) || quantity <= 0) return;
			const titleCell = cell("title");
			const sku = textOf(cell("sku")).split(/\s{2,}/)[0] || undefined;
			const mpn = textOf(cell("mpn")) || undefined;
			const title = textOf(titleCell) || mpn || sku;
			if (!title) return;
			const unit = parseMoney(textOf(cell("unit")), { currency });
			const total = parseMoney(textOf(cell("total")), { currency });
			const link = (titleCell ?? row).find("a[href]").first();
			items.push({
				title,
				sku: sku ?? mpn,
				variant: mpn && sku && mpn !== title ? `MPN: ${mpn}` : undefined,
				quantity,
				unitPriceMinor:
					unit?.amountMinor ??
					(total ? Math.round(total.amountMinor / quantity) : undefined),
				totalMinor:
					total?.amountMinor ??
					(unit ? unit.amountMinor * quantity : undefined),
				itemUrl: absUrl(link.attr("href"), base),
				imageUrl: imageUrl(row.find("img"), base),
			});
		});
	});
	return items;
}
