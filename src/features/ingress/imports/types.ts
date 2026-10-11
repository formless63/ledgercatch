/**
 * Spreadsheet import mapping model (client-safe).
 *
 * A mapping turns spreadsheet rows into ParsedOrder objects: each target
 * field reads a column (by header text), a constant, or (for the order id)
 * the file name. Rows sharing an order id are grouped into one order; rows
 * with item fields contribute line items.
 */
import { z } from "zod";
import type { ParsedOrder } from "#/features/parsing/types";

export const ORDER_FIELDS = [
	"externalOrderId",
	"orderDate",
	"merchantName",
	"currency",
	"subtotal",
	"shipping",
	"tax",
	"discount",
	"total",
	"status",
	"paymentHint",
	"orderUrl",
	"trackingNumber",
	"carrier",
] as const;
export const ITEM_FIELDS = [
	"title",
	"sku",
	"quantity",
	"unitPrice",
	"lineTotal",
	"itemUrl",
] as const;
export const TARGET_FIELDS = [...ORDER_FIELDS, ...ITEM_FIELDS] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];
export type ItemField = (typeof ITEM_FIELDS)[number];
export type TargetField = (typeof TARGET_FIELDS)[number];

export const MONEY_ORDER_FIELDS = [
	"subtotal",
	"shipping",
	"tax",
	"discount",
	"total",
] as const;
export type MoneyOrderField = (typeof MONEY_ORDER_FIELDS)[number];

export const FIELD_LABELS: Record<TargetField, string> = {
	externalOrderId: "Order ID",
	orderDate: "Order date",
	merchantName: "Merchant",
	currency: "Currency",
	subtotal: "Subtotal",
	shipping: "Shipping",
	tax: "Tax",
	discount: "Discount",
	total: "Total",
	status: "Status",
	paymentHint: "Payment / card",
	orderUrl: "Order URL",
	trackingNumber: "Tracking number",
	carrier: "Carrier",
	title: "Item title",
	sku: "SKU / part #",
	quantity: "Quantity",
	unitPrice: "Unit price",
	lineTotal: "Line total",
	itemUrl: "Item URL",
};

export const fieldSpecSchema = z.object({
	/** Header text of the source column. */
	column: z.string().max(300).optional(),
	/** Fixed value (or default when the column cell is empty). */
	constant: z.string().max(300).optional(),
	/** Order id only: take the longest digit run from the file name. */
	fromFileName: z.boolean().optional(),
});
export type FieldSpec = z.infer<typeof fieldSpecSchema>;

export const ORDER_STATUS_VALUES = [
	"placed",
	"processing",
	"shipped",
	"delivered",
	"cancelled",
	"returned",
	"unknown",
] as const;

export const rowFilterSchema = z.object({
	column: z.string().max(300),
	/** Case-insensitive regular expression tested against the cell text. */
	pattern: z.string().max(300),
	/** Keep rows that do NOT match. */
	negate: z.boolean().optional(),
});
export type RowFilter = z.infer<typeof rowFilterSchema>;

export const mappingOptionsSchema = z.object({
	/** Ambiguous dates like 03/04/2026 are day-first (EU). */
	dayFirst: z.boolean().optional(),
	/** Currency for amounts without a marker. */
	currency: z.string().max(3).optional(),
	/**
	 * Order-level money fields that repeat per line item row and must be
	 * summed (e.g. Amazon "Total Owed" is per item). Others take the first
	 * non-empty value of the group.
	 */
	sumFields: z.array(z.enum(MONEY_ORDER_FIELDS)).optional(),
	/** Use absolute values (PayPal shows purchases as negative gross). */
	absoluteAmounts: z.boolean().optional(),
	/** Exact (case-insensitive) status text → normalized status. */
	statusMap: z.record(z.string(), z.enum(ORDER_STATUS_VALUES)).optional(),
	/** Rows must match every filter to be imported. */
	filters: z.array(rowFilterSchema).max(10).optional(),
});
export type MappingOptions = z.infer<typeof mappingOptionsSchema>;

export const importMappingSchema = z.object({
	presetId: z.string().max(80).optional(),
	/** Store id (amazon, digikey, …) or "generic". */
	source: z.string().min(1).max(40),
	fields: z.partialRecord(z.enum(TARGET_FIELDS), fieldSpecSchema),
	options: mappingOptionsSchema,
});
export type ImportMapping = z.infer<typeof importMappingSchema>;

export type ImportStats = {
	orders: number;
	newCaptures: number;
	unchanged: number;
	skippedRows: number;
	errorRows: number;
	minDate?: string;
	maxDate?: string;
};

/** Shape stored in imports.preview (jsonb). */
export type ImportPreview = {
	sheets: string[];
	sheet: string | null;
	/** 0-based index of the header row inside the sheet. */
	headerRow: number;
	headers: string[];
	/** First rows after the header (cells as text). */
	rows: string[][];
	/** Data rows in the sheet (bounded). */
	totalRows: number;
	format: "csv" | "xlsx" | "html";
	detected?: { kind: "template" | "preset"; id: string; name: string } | null;
	errors?: Array<{ row: number; message: string }>;
	stats?: ImportStats;
};

/** A grouped order plus the 1-based sheet rows it came from. */
export type ImportedOrder = {
	order: ParsedOrder;
	rows: number[];
	warnings: string[];
};
