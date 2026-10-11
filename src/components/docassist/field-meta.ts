/** Display metadata per extracted field: label, color (box + chip), input kind. */
import type { FieldKey } from "#/features/ingress/documents/fields";

export type FieldMeta = {
	label: string;
	/** Hex color for document boxes and the field's swatch. */
	color: string;
	input: "text" | "money" | "date" | "currency" | "last4";
	placeholder?: string;
};

export const FIELD_META: Record<FieldKey, FieldMeta> = {
	merchantName: { label: "Merchant", color: "#38bdf8", input: "text" },
	externalOrderId: {
		label: "Order / invoice #",
		color: "#a855f7",
		input: "text",
	},
	orderDate: { label: "Date", color: "#f59e0b", input: "date" },
	currency: {
		label: "Currency",
		color: "#94a3b8",
		input: "currency",
		placeholder: "USD",
	},
	subtotal: { label: "Subtotal", color: "#2dd4bf", input: "money" },
	shipping: { label: "Shipping", color: "#818cf8", input: "money" },
	tax: { label: "Tax", color: "#f472b6", input: "money" },
	discount: { label: "Discount", color: "#fb923c", input: "money" },
	total: { label: "Total", color: "#10b981", input: "money" },
	paymentLast4: {
		label: "Card last 4",
		color: "#eab308",
		input: "last4",
		placeholder: "1234",
	},
};

export const ITEM_COLOR = "#64748b";

/** Order of fields in the form (Tab order). */
export const FORM_FIELDS: FieldKey[] = [
	"merchantName",
	"externalOrderId",
	"orderDate",
	"currency",
	"subtotal",
	"shipping",
	"tax",
	"discount",
	"total",
	"paymentLast4",
];

export function hexAlpha(hex: string, alpha: number) {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
