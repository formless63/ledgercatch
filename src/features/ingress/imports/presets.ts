/**
 * Built-in column mappings for spreadsheet exports that stores actually offer,
 * plus two generic layouts. Client-safe (used by the mapping UI too).
 *
 * Header matching is done on normalized header text (lowercase, punctuation
 * collapsed to single spaces: "Carrier Name & Tracking Number" →
 * "carrier name tracking number", "Ext.: (USD)" → "ext usd"). Aliases are
 * either exact normalized strings or regular expressions over that text.
 *
 * Sources and caveats (formats change; aliases are deliberately broad):
 * - Amazon "Request My Data" → Your Orders → Retail.OrderHistory.1.csv
 *   (2023+ also "Order History.csv": "Total Owed" ↔ "Total Amount",
 *   "Quantity" ↔ "Original Quantity", "Payment Instrument Type" ↔
 *   "Payment Method Type"). One row per item per shipment; money columns are
 *   per row, so totals are summed. "Order Status" "Closed" means completed.
 * - Amazon legacy "Order History Reports" (Items) — discontinued 2023 but
 *   many people still have the files.
 * - Amazon Business Analytics → Orders and shipments (item- or order-level).
 * - eBay: buyers have no official purchase CSV; this covers the "Download
 *   report"/GDPR purchase data and common third-party exporter columns.
 * - DigiKey: per sales order "Download CSV" (Index, Quantity, Part Number,
 *   Manufacturer Part Number, Description, Customer Reference, Unit Price,
 *   Extended Price) has no order column — the order number is taken from
 *   the file name; the order-history list export has "Sales Order".
 * - Mouser: Order History / order detail "Export to Excel" (Mouser #,
 *   Mfr. #, Desc., Order Qty., Price (USD), Ext.: (USD)); currency comes
 *   from the header suffix.
 * - AliExpress: "AliExpress Shopper Inventory" extension CSV/XLSX export
 *   CSV column compatibility: one row per product line.
 * - PayPal: Activity → Download (CSV). Only outgoing payments (negative
 *   Gross) are imported, as generic purchases keyed by Transaction ID.
 */
import type {
	FieldSpec,
	ImportMapping,
	MappingOptions,
	TargetField,
} from "./types";
import { TARGET_FIELDS } from "./types";

export type HeaderAlias = string | RegExp;

export type ImportPreset = {
	id: string;
	name: string;
	/** Store id or "generic". */
	source: string;
	description: string;
	/**
	 * Every group must match at least one header for the preset to be
	 * detected. Empty for the generic fallbacks.
	 */
	detect: HeaderAlias[][];
	columns: Partial<Record<TargetField, HeaderAlias[]>>;
	/** Constant values or defaults when the column is empty. */
	constants?: Partial<Record<TargetField, string>>;
	/** Take the order number from the file name when no column matches. */
	orderIdFromFileName?: boolean;
	options: MappingOptions;
};

export function normalizeHeader(header: string): string {
	return header
		.replace(/^﻿/, "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Stable signature used to auto-detect saved templates. */
export function headerSignature(headers: string[]): string {
	return headers
		.map(normalizeHeader)
		.filter(Boolean)
		.sort()
		.join("|")
		.slice(0, 4000);
}

function aliasMatches(alias: HeaderAlias, normalized: string) {
	return typeof alias === "string"
		? normalizeHeader(alias) === normalized
		: alias.test(normalized);
}

/** Index of the first header matching any alias (exact strings win). */
export function findColumn(
	headers: string[],
	aliases: HeaderAlias[],
	exclude: Set<number> = new Set(),
): number {
	const normalized = headers.map(normalizeHeader);
	for (const alias of aliases) {
		for (let i = 0; i < normalized.length; i++) {
			if (exclude.has(i) || !normalized[i]) continue;
			if (aliasMatches(alias, normalized[i] as string)) return i;
		}
	}
	return -1;
}

const ORDER_ID = [
	"order id",
	"order number",
	"order no",
	"order",
	"order ref",
	"order reference",
	"web order",
	"sales order",
	"sales order number",
	"invoice number",
	"invoice",
	"reference",
	"transaction id",
	"receipt number",
];
const ORDER_DATE = [
	"order date",
	"date ordered",
	"purchase date",
	"order placed",
	"placed",
	"date",
	"created",
	"created at",
	"transaction date",
];
const MERCHANT = [
	"merchant",
	"store",
	"store name",
	"shop",
	"vendor",
	"seller",
	"seller name",
	"supplier",
	"retailer",
	"website",
];
const TRACKING = [
	"tracking number",
	"tracking",
	"tracking no",
	"tracking id",
	"carrier name tracking number",
];

export const IMPORT_PRESETS: ImportPreset[] = [
	{
		id: "amazon-order-history",
		name: "Amazon order history (Request My Data)",
		source: "amazon",
		description:
			"Retail.OrderHistory.1.csv / Order History.csv from Amazon's “Request your data”. One row per item per shipment.",
		detect: [
			["order id"],
			["asin"],
			["product name"],
			["total owed", "total amount"],
		],
		columns: {
			externalOrderId: ["order id"],
			orderDate: ["order date"],
			currency: ["currency"],
			total: ["total owed", "total amount"],
			shipping: ["shipping charge"],
			discount: ["total discounts"],
			status: ["order status"],
			paymentHint: ["payment instrument type", "payment method type"],
			trackingNumber: ["carrier name tracking number"],
			title: ["product name"],
			sku: ["asin"],
			quantity: ["quantity", "original quantity"],
			unitPrice: ["unit price"],
		},
		constants: { merchantName: "Amazon" },
		options: {
			sumFields: ["total", "shipping", "discount"],
			statusMap: {
				closed: "delivered",
				new: "placed",
				authorized: "placed",
				"pending shipment": "processing",
			},
		},
	},
	{
		id: "amazon-legacy-items",
		name: "Amazon order history report (Items, legacy)",
		source: "amazon",
		description:
			"The pre-2023 “Order History Reports” Items CSV (ASIN/ISBN, Purchase Price Per Unit, Item Total).",
		detect: [["order id"], ["asin isbn"], ["purchase price per unit"]],
		columns: {
			externalOrderId: ["order id"],
			orderDate: ["order date"],
			currency: ["currency"],
			total: ["item total"],
			tax: ["item subtotal tax"],
			status: ["order status"],
			paymentHint: ["payment instrument type"],
			trackingNumber: ["carrier name tracking number"],
			title: ["title"],
			sku: ["asin isbn"],
			quantity: ["quantity"],
			unitPrice: ["purchase price per unit"],
			lineTotal: ["item subtotal"],
		},
		constants: { merchantName: "Amazon" },
		options: { sumFields: ["total", "tax"] },
	},
	{
		id: "amazon-business-items",
		name: "Amazon Business — orders & shipments (items)",
		source: "amazon",
		description:
			"Amazon Business Analytics item-level report (Purchase PPU, Item Net Total).",
		detect: [["order id"], ["purchase ppu"], ["item net total"]],
		columns: {
			externalOrderId: ["order id"],
			orderDate: ["order date"],
			currency: ["currency"],
			shipping: ["item shipping handling"],
			discount: ["item promotion"],
			tax: ["item tax"],
			total: ["item net total"],
			status: ["order status"],
			paymentHint: ["payment instrument type"],
			trackingNumber: ["carrier tracking", "carrier tracking number"],
			carrier: ["carrier name"],
			title: ["title"],
			sku: ["asin"],
			quantity: ["item quantity"],
			unitPrice: ["purchase ppu"],
			lineTotal: ["item subtotal"],
		},
		constants: { merchantName: "Amazon" },
		options: {
			sumFields: ["shipping", "discount", "tax", "total"],
			statusMap: { closed: "delivered" },
		},
	},
	{
		id: "amazon-business-orders",
		name: "Amazon Business — orders (order level)",
		source: "amazon",
		description:
			"Amazon Business Analytics order-level report (Order Net Total).",
		detect: [["order id"], ["order net total"]],
		columns: {
			externalOrderId: ["order id"],
			orderDate: ["order date"],
			currency: ["currency"],
			subtotal: ["order subtotal"],
			shipping: ["order shipping handling"],
			discount: ["order promotion"],
			tax: ["order tax"],
			total: ["order net total"],
			status: ["order status"],
			paymentHint: ["payment instrument type"],
		},
		constants: { merchantName: "Amazon" },
		options: { statusMap: { closed: "delivered" } },
	},
	{
		id: "ebay-purchases",
		name: "eBay purchase history",
		source: "ebay",
		description:
			"eBay purchase report / data download (Order number, Item number, Seller).",
		detect: [
			["order number", "order id"],
			["item number", "item id"],
			["seller", "seller user id", "seller name", "seller id"],
		],
		columns: {
			externalOrderId: ["order number", "order id"],
			orderDate: [
				"purchase date",
				"order date",
				"sale date",
				"paid on date",
				"date",
			],
			merchantName: ["seller", "seller user id", "seller name", "seller id"],
			currency: ["currency"],
			shipping: [
				"shipping",
				"shipping and handling",
				"postage and packaging",
				"shipping cost",
			],
			tax: ["tax", "sales tax", "ebay collected tax"],
			total: ["total price", "order total", "total"],
			status: ["status", "order status"],
			trackingNumber: ["tracking number"],
			carrier: ["shipping service", "carrier"],
			title: ["item title", "title"],
			sku: ["item number", "item id"],
			quantity: ["quantity", "qty"],
			unitPrice: ["item price", "sold for", "price"],
		},
		constants: { merchantName: "eBay" },
		options: {},
	},
	{
		id: "digikey",
		name: "DigiKey order (CSV/XLSX)",
		source: "digikey",
		description:
			"DigiKey sales order download (Part Number, Manufacturer Part Number, Extended Price). Without a Sales Order column the order number comes from the file name.",
		detect: [
			["extended price", /^extended price [a-z]{3}$/],
			["manufacturer part number", "mfr part number", "mfr part"],
			[
				"digi key part number",
				"digikey part number",
				"part number",
				/^digi ?key part/,
			],
		],
		columns: {
			externalOrderId: [
				"sales order",
				"sales order number",
				"salesorder",
				"order number",
				"web id",
			],
			orderDate: ["date", "order date", "date entered", "date ordered"],
			status: ["status", "order status"],
			trackingNumber: TRACKING,
			title: ["description", "product description"],
			sku: [
				"digi key part number",
				"digikey part number",
				/^digi ?key part/,
				"part number",
			],
			quantity: ["quantity", "qty", "quantity ordered"],
			unitPrice: ["unit price", /^unit price [a-z]{3}$/],
			lineTotal: ["extended price", /^extended price [a-z]{3}$/],
		},
		constants: { merchantName: "DigiKey", currency: "USD" },
		orderIdFromFileName: true,
		options: {},
	},
	{
		id: "mouser",
		name: "Mouser order (Excel export)",
		source: "mouser",
		description:
			"Mouser order history / order detail export (Mouser #, Mfr. #, Order Qty., Price (USD), Ext.: (USD)).",
		detect: [
			["mouser", "mouser part", "mouser part number", "mouser no"],
			["mfr", "mfr part", "manufacturer part number", "mfr part number"],
		],
		columns: {
			externalOrderId: [
				"web order",
				"web order number",
				"sales order",
				"sales order number",
				"order",
				"order number",
			],
			orderDate: ["order date", "date"],
			status: ["status", "order status"],
			trackingNumber: TRACKING,
			title: ["desc", "description"],
			sku: ["mouser", "mouser part", "mouser part number", "mouser no"],
			quantity: ["order qty", "qty", "quantity"],
			unitPrice: [/^(unit )?price( [a-z]{3})?$/],
			lineTotal: [/^ext(ended)?( price)?( [a-z]{3})?$/],
		},
		constants: { merchantName: "Mouser Electronics" },
		orderIdFromFileName: true,
		options: {},
	},
	{
		id: "aliexpress-shopper-inventory",
		name: "AliExpress (Shopper Inventory export)",
		source: "aliexpress",
		description:
			"CSV/XLSX from the “AliExpress Shopper Inventory” browser extension. One row per product line.",
		detect: [["order id"], ["product id"], ["sku id"], ["price cost"]],
		columns: {
			externalOrderId: ["order id"],
			orderDate: ["order date"],
			merchantName: ["store"],
			currency: ["currency"],
			status: ["status"],
			trackingNumber: ["tracking number"],
			carrier: ["tracking carrier"],
			title: ["title"],
			sku: ["product id"],
			quantity: ["qty"],
			unitPrice: ["price"],
			itemUrl: ["product url"],
		},
		constants: { merchantName: "AliExpress" },
		options: {},
	},
	{
		id: "paypal-activity",
		name: "PayPal activity (purchases)",
		source: "generic",
		description:
			"PayPal Activity → Download CSV. Imports outgoing payments only, one order per transaction, merchant from Name.",
		detect: [["transaction id"], ["gross"], ["net"], ["type"]],
		columns: {
			externalOrderId: ["transaction id"],
			orderDate: ["date"],
			merchantName: ["name"],
			currency: ["currency"],
			shipping: ["shipping and handling amount"],
			tax: ["sales tax"],
			total: ["gross"],
			title: ["item title"],
			sku: ["item id"],
			quantity: ["quantity"],
		},
		constants: { paymentHint: "PayPal" },
		options: {
			absoluteAmounts: true,
			filters: [
				{ column: "Gross", pattern: "^\\s*[-−(]" },
				{
					column: "Type",
					pattern:
						"conversion|transfer|withdraw|deposit|hold|authori[sz]ation|refund|reversal|reserve",
					negate: true,
				},
				{
					column: "Status",
					pattern: "denied|failed|canceled|cancelled",
					negate: true,
				},
			],
		},
	},
	{
		id: "generic-items",
		name: "Generic — one row per line item",
		source: "generic",
		description:
			"Any export with an order column and item columns (title, SKU, quantity, price). Rows with the same order are grouped.",
		detect: [],
		columns: {
			externalOrderId: ORDER_ID,
			orderDate: ORDER_DATE,
			merchantName: MERCHANT,
			currency: ["currency", "currency code"],
			shipping: ["shipping", "shipping cost", "delivery", "postage"],
			tax: ["tax", "vat", "sales tax"],
			discount: ["discount", "discounts", "promotion"],
			total: ["order total", "grand total", "total amount", "total"],
			status: ["status", "order status"],
			paymentHint: ["payment", "payment method", "card"],
			orderUrl: ["order url", "url", "link"],
			trackingNumber: TRACKING,
			carrier: ["carrier", "shipping carrier"],
			title: [
				"item",
				"item title",
				"item name",
				"product",
				"product name",
				"description",
				"title",
				"name",
			],
			sku: ["sku", "part number", "item number", "asin", "mpn", "item id"],
			quantity: ["quantity", "qty", "units", "count"],
			unitPrice: ["unit price", "price each", "unit cost", "price"],
			lineTotal: ["line total", "extended price", "item total", "amount"],
			itemUrl: ["item url", "product url"],
		},
		options: {},
	},
	{
		id: "generic-orders",
		name: "Generic — one row per order",
		source: "generic",
		description:
			"One row per order: order id, date, merchant, total. An optional description column becomes a single line item.",
		detect: [],
		columns: {
			externalOrderId: ORDER_ID,
			orderDate: ORDER_DATE,
			merchantName: MERCHANT,
			currency: ["currency", "currency code"],
			subtotal: ["subtotal", "sub total"],
			shipping: ["shipping", "shipping cost", "delivery", "postage"],
			tax: ["tax", "vat", "sales tax"],
			discount: ["discount", "discounts"],
			total: [
				"total",
				"order total",
				"grand total",
				"total amount",
				"amount",
				"price",
			],
			status: ["status", "order status"],
			paymentHint: ["payment", "payment method", "card"],
			orderUrl: ["order url", "url", "link"],
			trackingNumber: TRACKING,
			carrier: ["carrier"],
			title: ["description", "items", "item", "product", "memo"],
		},
		options: {},
	},
];

export function getPreset(id: string | undefined): ImportPreset | undefined {
	return id ? IMPORT_PRESETS.find((p) => p.id === id) : undefined;
}

/** Resolves a preset against concrete headers into a mapping. */
export function buildPresetMapping(
	preset: ImportPreset,
	headers: string[],
): ImportMapping {
	const used = new Set<number>();
	const fields: ImportMapping["fields"] = {};
	for (const field of TARGET_FIELDS) {
		const aliases = preset.columns[field];
		const spec: FieldSpec = {};
		if (aliases) {
			const index = findColumn(headers, aliases, used);
			if (index >= 0) {
				used.add(index);
				spec.column = headers[index];
			}
		}
		const constant = preset.constants?.[field];
		if (constant) spec.constant = constant;
		if (field === "externalOrderId" && preset.orderIdFromFileName)
			spec.fromFileName = true;
		if (spec.column || spec.constant || spec.fromFileName) fields[field] = spec;
	}
	const options: MappingOptions = structuredClone(preset.options);
	// Resolve filter columns to actual header text.
	if (options.filters) {
		options.filters = options.filters.flatMap((filter) => {
			const index = findColumn(headers, [filter.column]);
			return index >= 0
				? [{ ...filter, column: headers[index] as string }]
				: [];
		});
	}
	const fromHeader = currencyFromHeaders(headers);
	if (fromHeader && !fields.currency?.column) {
		// "Price (EUR)" beats a preset's default currency.
		options.currency = options.currency ?? fromHeader;
		delete fields.currency;
	}
	return { presetId: preset.id, source: preset.source, fields, options };
}

/** "Price (USD)", "Ext.: (EUR)", "Unit Price (GBP)" → currency code. */
export function currencyFromHeaders(headers: string[]): string | undefined {
	for (const header of headers) {
		const match =
			/\b(?:price|ext|extended|total|amount)\b.*\(([A-Z]{3})\)/i.exec(header);
		if (match?.[1]) return match[1].toUpperCase();
	}
	return undefined;
}

export type PresetMatch = { preset: ImportPreset; score: number };

/** Best built-in preset for these headers (always returns a generic fallback). */
export function detectPreset(headers: string[]): PresetMatch {
	let best: PresetMatch | undefined;
	for (const preset of IMPORT_PRESETS) {
		if (!preset.detect.length) continue;
		const ok = preset.detect.every((group) => findColumn(headers, group) >= 0);
		if (!ok) continue;
		const score = 100 + preset.detect.length;
		if (!best || score > best.score) best = { preset, score };
	}
	if (best) return best;
	const items = getPreset("generic-items") as ImportPreset;
	const orders = getPreset("generic-orders") as ImportPreset;
	const hasItemColumns =
		findColumn(headers, items.columns.sku ?? []) >= 0 ||
		findColumn(headers, items.columns.quantity ?? []) >= 0 ||
		findColumn(headers, ["unit price", "price each", "unit cost"]) >= 0;
	return { preset: hasItemColumns ? items : orders, score: 0 };
}

export type TemplateLike = {
	id: string;
	name: string;
	source: string;
	headerSignature: string;
	mapping: unknown;
};

/**
 * Picks a mapping for an uploaded sheet: a saved template with the same
 * header signature wins, then a template whose mapped columns all exist,
 * then the built-in presets.
 */
export function detectMapping(
	headers: string[],
	templates: TemplateLike[],
	parseMapping: (value: unknown) => ImportMapping | null,
): {
	mapping: ImportMapping;
	detected: { kind: "template" | "preset"; id: string; name: string };
	templateId: string | null;
} {
	const signature = headerSignature(headers);
	const headerSet = new Set(headers);
	const exact = templates.find((t) => t.headerSignature === signature);
	const candidates = exact
		? [exact]
		: templates.filter((t) => {
				const mapping = parseMapping(t.mapping);
				if (!mapping) return false;
				const columns = Object.values(mapping.fields).flatMap((spec) =>
					spec?.column ? [spec.column] : [],
				);
				return columns.length > 0 && columns.every((c) => headerSet.has(c));
			});
	for (const template of candidates) {
		const mapping = parseMapping(template.mapping);
		if (mapping)
			return {
				mapping,
				detected: { kind: "template", id: template.id, name: template.name },
				templateId: template.id,
			};
	}
	const { preset } = detectPreset(headers);
	return {
		mapping: buildPresetMapping(preset, headers),
		detected: { kind: "preset", id: preset.id, name: preset.name },
		templateId: null,
	};
}
