/**
 * Zod input/output schemas for the agent API (REST v1 + MCP). Pure Zod: shared
 * by the REST handlers, the MCP tools and the OpenAPI contracts. Ledger input
 * schemas are reused from src/features/ledger/inputs.ts.
 */
import { z } from "zod";
import {
	bulkOrderUpdateInput,
	captureListInput,
	categoryInput,
	claimStatusInput,
	createClaimInput,
	entityInput,
	insightsInput,
	orderItemUpdateInput,
	orderListInput,
	orderUpdateInput,
	paymentMethodInput,
	reimbursementStatusInput,
	ruleInput,
} from "#/features/ledger/inputs";
import { documentKindSchema, STORE_IDS } from "#/shared/capture";

export const uuid = z.string().uuid();

/** Query-string friendly boolean ("true"/"false" or a JSON boolean). */
const queryBoolean = z
	.union([z.boolean(), z.enum(["true", "false", "1", "0"])])
	.transform((value) => value === true || value === "true" || value === "1");

const limit = (max: number, fallback: number) =>
	z.coerce
		.number()
		.int()
		.min(1)
		.max(max)
		.default(fallback)
		.describe(`Page size (1–${max}, default ${fallback}).`);
const offset = z.coerce
	.number()
	.int()
	.min(0)
	.max(100_000)
	.default(0)
	.describe("Rows to skip (pagination). Response `total` is the full count.");

/* ───────────────────────── path params ───────────────────────── */

export const orderIdParams = z.object({ orderId: uuid });
export const orderItemParams = z.object({ orderId: uuid, itemId: uuid });
export const claimIdParams = z.object({ claimId: uuid });
export const entityIdParams = z.object({ entityId: uuid });
export const categoryIdParams = z.object({ categoryId: uuid });
export const paymentMethodIdParams = z.object({ paymentMethodId: uuid });
export const ruleIdParams = z.object({ ruleId: uuid });
export const captureIdParams = z.object({ captureId: uuid });
export const documentIdParams = z.object({ documentId: uuid });
export const connectionIdParams = z.object({ connectionId: uuid });

/* ───────────────────────── orders ───────────────────────── */

export const orderListQuery = orderListInput.extend({
	view: orderListInput.shape.view.describe(
		"`inbox` = untriaged, `filed` = triaged, `ignored`, or `all` (default).",
	),
	entityId: orderListInput.shape.entityId.describe(
		"Entity id (matches primary entity or any allocation), or `unassigned`.",
	),
	status: orderListInput.shape.status.describe(
		"Order status: placed, processing, shipped, delivered, cancelled, returned, unknown.",
	),
	reimbursement: orderListInput.shape.reimbursement.describe(
		"Only orders with an allocation in this reimbursement state (`reimbursable` = any reimbursable).",
	),
	missingInvoice: queryBoolean
		.optional()
		.describe("Only orders without an invoice/receipt document."),
	from: orderListInput.shape.from.describe("Order date ≥ (YYYY-MM-DD)."),
	to: orderListInput.shape.to.describe("Order date ≤ (YYYY-MM-DD)."),
	q: orderListInput.shape.q.describe(
		"Full-text search over merchant, order number, item titles, notes.",
	),
	limit: limit(500, 50),
	offset,
});

export const inboxQuery = z.object({ limit: limit(500, 50), offset });

const minor = z
	.number()
	.int()
	.min(-1_000_000_000_000)
	.max(1_000_000_000_000)
	.describe("Amount in minor units (cents) of the order currency.");

export const agentItemSchema = z.object({
	externalItemId: z.string().trim().max(200).optional(),
	title: z.string().trim().min(1).max(500),
	sku: z.string().trim().max(200).optional(),
	variant: z.string().trim().max(500).optional(),
	quantity: z.number().positive().max(1_000_000).default(1),
	unitPriceMinor: minor.optional(),
	totalMinor: minor.optional().describe("Line total in minor units."),
	imageUrl: z.string().url().max(2000).optional(),
	itemUrl: z.string().url().max(2000).optional(),
});

export const agentShipmentSchema = z.object({
	carrier: z.string().trim().max(120).optional(),
	trackingNumber: z.string().trim().min(1).max(200),
	status: z.string().trim().max(120).optional(),
	shippedAt: z.string().max(40).optional(),
	deliveredAt: z.string().max(40).optional(),
	etaText: z.string().max(200).optional(),
});

export const triageSchema = z
	.object({
		entityId: uuid.nullable().optional(),
		categoryId: uuid.nullable().optional(),
		paymentMethodId: uuid.nullable().optional(),
		reimbursableOverride: z.boolean().nullable().optional(),
		reviewState: z.enum(["inbox", "filed", "ignored"]).optional(),
		notes: z.string().max(5000).nullable().optional(),
		tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	})
	.describe(
		"Optional triage applied after the order is ingested (overrides rule results).",
	);

export const agentOrderSchema = z.object({
	externalOrderId: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe(
			"The store's order number. (source, externalOrderId) identifies an order; re-posting merges.",
		),
	merchantName: z.string().trim().max(200).optional(),
	orderUrl: z.string().url().max(2000).optional(),
	orderDate: z.string().date().optional().describe("YYYY-MM-DD."),
	status: z
		.enum([
			"placed",
			"processing",
			"shipped",
			"delivered",
			"cancelled",
			"returned",
			"unknown",
		])
		.optional(),
	statusText: z.string().max(200).optional(),
	currency: z
		.string()
		.trim()
		.length(3)
		.toUpperCase()
		.optional()
		.describe("ISO-4217 code, e.g. USD."),
	subtotalMinor: minor.optional(),
	shippingMinor: minor.optional(),
	taxMinor: minor.optional(),
	discountMinor: minor.optional(),
	totalMinor: minor.optional(),
	paymentHint: z
		.string()
		.max(200)
		.optional()
		.describe('Free text like "Visa ending in 4821".'),
	paymentLast4: z
		.string()
		.regex(/^\d{4}$/)
		.optional()
		.describe("Card last 4; links (or creates) the payment method."),
	items: z
		.array(agentItemSchema)
		.max(500)
		.optional()
		.describe("Complete item list; replaces stored items."),
	itemsPartial: z.boolean().optional(),
	shipments: z.array(agentShipmentSchema).max(50).optional(),
	triage: triageSchema.optional(),
});
export type AgentOrderInput = z.output<typeof agentOrderSchema>;

export const createOrdersBody = z.object({
	source: z
		.enum(STORE_IDS)
		.default("generic")
		.describe(
			"Store id. Use `generic` for any other shop; generic order numbers are namespaced by the order URL host (or merchant name).",
		),
	orders: z.array(agentOrderSchema).min(1).max(50),
	note: z.string().max(2000).optional(),
	wait: z
		.boolean()
		.default(true)
		.describe(
			"Wait (≤10 s) for ingestion so the response includes order ids. When false, poll GET /api/v1/captures/{captureId}.",
		),
});

export const orderPatchBody = orderUpdateInput.omit({ id: true }).extend({
	addTags: z
		.array(z.string().trim().min(1).max(40))
		.max(20)
		.optional()
		.describe("Tags to add (kept unique)."),
	removeTags: z
		.array(z.string().trim().min(1).max(40))
		.max(20)
		.optional()
		.describe("Tags to remove."),
});

export const bulkOrdersBody = bulkOrderUpdateInput;
export const itemPatchBody = orderItemUpdateInput.omit({ itemId: true });
export const splitOrderBody = z.object({
	items: z
		.array(orderItemUpdateInput)
		.min(1)
		.max(200)
		.describe(
			"Per-item entity/category overrides. `entityId: null` returns the item to the order's primary entity.",
		),
});

/* ───────────────────────── reimbursements & claims ───────────────────────── */

export const reimbursementBody = reimbursementStatusInput;
export const createClaimBody = createClaimInput;
export const claimPatchBody = claimStatusInput.omit({ id: true });
export const claimListQuery = z.object({
	status: z.enum(["draft", "submitted", "paid", "void"]).optional(),
	limit: limit(200, 50),
	offset,
});

/* ───────────────────────── settings ───────────────────────── */

export const listQuery = z.object({
	includeArchived: queryBoolean
		.optional()
		.describe("Include archived rows (default false)."),
});
export const entityCreateBody = entityInput.omit({ id: true });
export const entityPatchBody = entityCreateBody.partial();
export const categoryCreateBody = categoryInput.omit({ id: true });
export const categoryPatchBody = categoryCreateBody.partial();
export const paymentMethodCreateBody = paymentMethodInput.omit({ id: true });
export const paymentMethodPatchBody = paymentMethodCreateBody.partial();

/* ───────────────────────── rules ───────────────────────── */

export const ruleBody = ruleInput.omit({ id: true });
export const ruleDryRunBody = ruleInput;

/* ───────────────────────── captures, documents, exports ───────────────────────── */

export const captureListQuery = captureListInput.extend({
	channel: z
		.enum([
			"extension",
			"upload",
			"email",
			"import",
			"paperless",
			"agent",
			"api",
		])
		.optional(),
	limit: limit(200, 50),
	offset,
});
export const captureGetQuery = z.object({
	includeBody: queryBoolean
		.optional()
		.describe("Include the raw body (truncated at 400k chars). Default true."),
});
export const reprocessCapturesBody = z.object({
	captureIds: z.array(uuid).min(1).max(200),
});

export const documentUploadForm = z.object({
	file: z.string().meta({
		description: "PDF or image, up to 25 MiB.",
		contentMediaType: "application/octet-stream",
	}),
	kind: documentKindSchema.default("invoice"),
	fileName: z.string().max(200).optional(),
});
export const documentUploadJson = z.object({
	kind: documentKindSchema.default("invoice"),
	fileName: z.string().trim().min(1).max(200),
	contentType: z.enum([
		"application/pdf",
		"image/png",
		"image/jpeg",
		"image/webp",
	]),
	base64: z
		.string()
		.min(4)
		.max(8 * 1024 * 1024)
		.describe("File bytes, base64-encoded (≤ ~6 MiB decoded)."),
});

export const queueExportBody = z
	.object({
		allocationIds: z.array(uuid).max(500).optional(),
		orderIds: z.array(uuid).max(500).optional(),
		connectionId: uuid
			.optional()
			.describe(
				"Restrict to one connection (default: every enabled connection of the allocation's entity).",
			),
		force: z
			.boolean()
			.default(false)
			.describe("Re-send allocations already exported."),
	})
	.refine(
		(value) => Boolean(value.allocationIds?.length || value.orderIds?.length),
		"Provide allocationIds or orderIds",
	);

export const insightsQuery = insightsInput;

/* ───────────────────────── responses ───────────────────────── */

const looseRow = (description: string) =>
	z.looseObject({ id: z.string() }).describe(description);

export const okSchema = z.object({ ok: z.boolean() });
export const updatedSchema = z.object({ updated: z.number().int() });
export const idCreatedSchema = z.object({
	id: z.string(),
	created: z.boolean().describe("False when an existing record was returned."),
});

export const allocationSchema = z.looseObject({
	id: z.string(),
	entityId: z.string(),
	amountMinor: z.number(),
	currency: z.string(),
	reimbursable: z.boolean(),
	reimbursementStatus: z.string(),
});

export const orderSummarySchema = z
	.looseObject({
		id: z.string(),
		source: z.string(),
		externalOrderId: z.string(),
		merchantName: z.string().nullable(),
		orderDate: z.string().nullable(),
		status: z.string(),
		currency: z.string().nullable(),
		totalMinor: z.number().nullable(),
		entityId: z.string().nullable(),
		categoryId: z.string().nullable(),
		paymentMethodId: z.string().nullable(),
		reviewState: z.string(),
		tags: z.array(z.string()),
		itemCount: z.number(),
		documentCount: z.number(),
		allocations: z.array(allocationSchema),
	})
	.meta({ id: "AgentOrderSummary" });

export const orderListResponse = z.object({
	total: z.number().int(),
	limit: z.number().int(),
	offset: z.number().int(),
	orders: z.array(orderSummarySchema),
});

export const orderDetailResponse = z
	.looseObject({
		order: z.looseObject({ id: z.string() }),
		items: z.array(looseRow("Line item (entityId/categoryId = override)")),
		shipments: z.array(looseRow("Shipment")),
		allocations: z.array(allocationSchema),
		documents: z.array(looseRow("Document metadata")),
		captures: z.array(looseRow("Provenance capture")),
		history: z.array(looseRow("Audit event")),
		exports: z.array(looseRow("Export attempt")),
	})
	.meta({ id: "AgentOrderDetail" });

export const createOrdersResponse = z.object({
	pending: z
		.boolean()
		.describe(
			"True when some captures were not processed within the wait window.",
		),
	results: z.array(
		z.object({
			index: z.number().int(),
			externalOrderId: z.string(),
			captureId: z.string(),
			duplicate: z
				.boolean()
				.describe("Idempotency hit: this capture already existed."),
			captureStatus: z.string(),
			orderId: z.string().nullable(),
			triageApplied: z.boolean(),
			error: z.string().nullable(),
		}),
	),
});

export const meResponse = z.object({
	user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
	key: z.object({
		id: z.string(),
		permissions: z.record(z.string(), z.array(z.string())),
		grants: z.array(z.string()),
	}),
	entities: z.array(looseRow("Entity")),
	categories: z.array(looseRow("Category")),
	paymentMethods: z.array(looseRow("Payment method")),
	counts: z.object({
		inbox: z.number(),
		capturesNeedingAttention: z.number(),
	}),
	links: z.object({
		openapi: z.string(),
		docs: z.string(),
		mcp: z.string(),
		app: z.string(),
	}),
});

export const listOf = (key: string, description: string) =>
	z.object({ [key]: z.array(looseRow(description)) });

export const pagedListOf = (key: string, description: string) =>
	z.object({
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
		[key]: z.array(looseRow(description)),
	});

export const looseResponse = (description: string) =>
	z.looseObject({}).describe(description);

export const documentUploadResponse = z.object({
	documentId: z.string(),
	duplicate: z.boolean(),
	orderId: z.string().nullable(),
});
