/** Zod inputs for the document review server functions (client-safe). */
import { z } from "zod";
import { FIELD_KEYS } from "./fields";

const id = z.string().uuid();
const decimal = z
	.string()
	.trim()
	.regex(/^-?\d{1,12}(\.\d{1,3})?$/, "Expected a decimal amount");
const optionalDecimal = decimal
	.optional()
	.or(z.literal("").transform(() => undefined));

export const QUEUE_VIEWS = ["review", "done", "ignored"] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export const documentQueueInput = z.object({
	view: z.enum(QUEUE_VIEWS).default("review"),
	limit: z.number().int().min(1).max(200).default(100),
});

export const captureIdInput = z.object({ captureId: id });

export const analyzeDocumentInput = z.object({
	captureId: id,
	ocr: z.enum(["auto", "force"]).default("auto"),
});

const wordRef = z.object({
	page: z.number().int().min(0).max(50),
	index: z.number().int().min(0).max(100_000),
});

export const createOrderFromDocumentInput = z.object({
	captureId: id,
	merchantName: z.string().trim().min(1).max(200),
	externalOrderId: z.string().trim().max(120).optional(),
	orderDate: z
		.string()
		.date()
		.optional()
		.or(z.literal("").transform(() => undefined)),
	currency: z.string().trim().length(3).toUpperCase(),
	subtotal: optionalDecimal,
	shipping: optionalDecimal,
	tax: optionalDecimal,
	discount: optionalDecimal,
	total: decimal,
	paymentLast4: z
		.string()
		.trim()
		.regex(/^\d{4}$/)
		.optional()
		.or(z.literal("").transform(() => undefined)),
	entityId: id.nullable().optional(),
	categoryId: id.nullable().optional(),
	documentKind: z.enum(["invoice", "receipt"]).default("invoice"),
	notes: z.string().max(5000).optional(),
	items: z
		.array(
			z.object({
				title: z.string().trim().min(1).max(500),
				quantity: z.number().positive().max(1_000_000).default(1),
				unitPrice: optionalDecimal,
				total: optionalDecimal,
			}),
		)
		.max(200)
		.default([]),
	/** Word boxes that filled each field (remembered per merchant). */
	fieldRefs: z
		.partialRecord(z.enum(FIELD_KEYS), z.array(wordRef).max(200))
		.default({}),
	learn: z.boolean().default(true),
});
export type CreateOrderFromDocumentInput = z.input<
	typeof createOrderFromDocumentInput
>;

export const attachDocumentInput = z.object({
	captureId: id,
	orderId: id,
	documentKind: z.enum(["invoice", "receipt"]).default("invoice"),
});

export const searchOrdersInput = z.object({
	q: z.string().trim().max(200).default(""),
	totalMinor: z.number().int().optional(),
});
