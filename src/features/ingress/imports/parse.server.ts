/**
 * kind "import_row": the capture body already holds a ParsedOrder built by
 * the spreadsheet import job (bodyJson = { importId, order }). Validate it
 * and pass it through.
 */
import { z } from "zod";
import type { ParsedOrder } from "#/features/parsing/types";
import type { CaptureRow, KindParseOutcome } from "../types";
import { ORDER_STATUS_VALUES } from "./types";

export const IMPORT_PARSER_VERSION = 1;

const minor = z.number().int().finite().optional();
const text = (max: number) => z.string().max(max).optional();

export const parsedOrderSchema = z.object({
	externalOrderId: z.string().trim().min(1).max(200),
	merchantName: text(200),
	orderUrl: text(2000),
	orderDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	status: z.enum(ORDER_STATUS_VALUES).optional(),
	statusText: text(200),
	currency: z
		.string()
		.regex(/^[A-Z]{3}$/)
		.optional(),
	subtotalMinor: minor,
	shippingMinor: minor,
	taxMinor: minor,
	discountMinor: minor,
	totalMinor: minor,
	paymentHint: text(200),
	paymentLast4: z
		.string()
		.regex(/^\d{4}$/)
		.optional(),
	items: z
		.array(
			z.object({
				title: z.string().min(1).max(500),
				sku: text(200),
				quantity: z.number().finite().positive(),
				unitPriceMinor: minor,
				totalMinor: minor,
				itemUrl: text(2000),
			}),
		)
		.max(2000)
		.optional(),
	shipments: z
		.array(
			z.object({
				trackingNumber: z.string().min(1).max(80),
				carrier: text(80),
			}),
		)
		.max(100)
		.optional(),
});

const bodySchema = z.object({
	importId: z.string().optional(),
	order: parsedOrderSchema,
});

export async function parseImportRowCapture(
	capture: CaptureRow,
): Promise<KindParseOutcome> {
	const parsed = bodySchema.safeParse(capture.bodyJson);
	if (!parsed.success)
		return {
			result: {
				outcome: "unsupported",
				reason: `Invalid import row: ${parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; ")}`,
			},
			parserId: "import",
			version: IMPORT_PARSER_VERSION,
		};
	const order: ParsedOrder = parsed.data.order;
	return {
		result: { outcome: "orders", orders: [order], warnings: [] },
		parserId: "import",
		version: IMPORT_PARSER_VERSION,
	};
}
