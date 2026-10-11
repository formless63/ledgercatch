/**
 * Capture contract shared by the browser extension and the server.
 *
 * Pure Zod only: this file is imported by the extension bundle (via the
 * `@app/shared` alias) and must never import server code.
 */
import { z } from "zod";

export const CAPTURE_SCHEMA_VERSION = 1 as const;

export const STORE_IDS = [
	"amazon",
	"aliexpress",
	"alibaba",
	"ebay",
	"digikey",
	"mouser",
	"generic",
] as const;
export const storeIdSchema = z.enum(STORE_IDS);
export type StoreId = z.infer<typeof storeIdSchema>;

/** What the captured payload is. */
export const captureKindSchema = z.enum([
	/** A JSON response body the store's own page fetched (fetch/XHR interception). */
	"api_json",
	/** Serialized DOM of an order page (order list, detail, confirmation, invoice). */
	"html_snapshot",
	/** Visible text (+ optional screenshot) of an arbitrary page — "track this order". */
	"page_text",
]);
export type CaptureKind = z.infer<typeof captureKindSchema>;

export const captureTriggerSchema = z.enum([
	/** Captured automatically while browsing. */
	"passive",
	/** User pressed the capture button. */
	"manual",
	/** Extension-driven crawl of order history pages. */
	"backfill",
]);

export const pageTypeSchema = z.enum([
	"order_list",
	"order_detail",
	"order_confirmation",
	"invoice",
	"unknown",
]);
export type PageType = z.infer<typeof pageTypeSchema>;

export const MAX_HTML_BYTES = 6 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const capturePayloadSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("json"),
		/** URL of the intercepted request (no credentials). */
		requestUrl: z.string().url(),
		body: z.unknown(),
	}),
	z.object({
		type: z.literal("html"),
		html: z.string().max(MAX_HTML_BYTES),
	}),
	z.object({
		type: z.literal("text"),
		text: z.string().max(MAX_TEXT_BYTES),
		/** Optional JPEG/PNG data URL of the visible viewport. */
		screenshotDataUrl: z
			.string()
			.max(MAX_SCREENSHOT_BYTES * 1.4)
			.regex(/^data:image\/(png|jpeg|webp);base64,/)
			.optional(),
		/** Optional user note typed in the capture popup. */
		note: z.string().max(2000).optional(),
		/**
		 * Optional serialized DOM of the same page ("Track this page"), with
		 * executable scripts stripped except JSON-LD / known order-data
		 * globals. Lets the server try deterministic platform parsers before
		 * falling back to AI extraction on `text`.
		 */
		html: z.string().max(MAX_HTML_BYTES).optional(),
	}),
]);
export type CapturePayload = z.infer<typeof capturePayloadSchema>;

export const captureEnvelopeSchema = z.object({
	schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
	/** Client-generated UUID; the server treats repeats as idempotent. */
	captureId: z.string().uuid(),
	source: storeIdSchema,
	kind: captureKindSchema,
	trigger: captureTriggerSchema,
	pageType: pageTypeSchema.default("unknown"),
	pageUrl: z.string().url(),
	pageTitle: z.string().max(1000).default(""),
	capturedAt: z.string().datetime({ offset: true }),
	extensionVersion: z.string().max(40),
	/** Store order IDs the extension believes are on this page (optional hint). */
	orderIdHints: z.array(z.string().max(120)).max(200).default([]),
	payload: capturePayloadSchema,
});
export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>;
export type CaptureEnvelopeInput = z.input<typeof captureEnvelopeSchema>;

export const captureResponseSchema = z.object({
	captureId: z.string().uuid(),
	/** "accepted" for new captures, "duplicate" when the same content was seen before. */
	status: z.enum(["accepted", "duplicate"]),
});
export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export const documentKindSchema = z.enum([
	"invoice",
	"receipt",
	"packing_slip",
	"order_page",
	"other",
]);
export type DocumentKind = z.infer<typeof documentKindSchema>;

/**
 * Metadata sent as the `meta` JSON field of a multipart POST /api/v1/documents
 * request; the binary goes in the `file` field.
 */
export const documentUploadMetaSchema = z.object({
	source: storeIdSchema,
	/** Store order number the document belongs to, when known. */
	externalOrderId: z.string().max(120).optional(),
	kind: documentKindSchema,
	originUrl: z.string().url().optional(),
	/** Capture that led to this document, when applicable. */
	captureId: z.string().uuid().optional(),
	fileName: z.string().max(255),
});
export type DocumentUploadMeta = z.infer<typeof documentUploadMetaSchema>;

/** GET /api/v1/extension/status — key check + what the server already knows. */
export const extensionStatusSchema = z.object({
	appName: z.string(),
	user: z.object({ name: z.string(), email: z.string() }),
	serverTime: z.string(),
});
export type ExtensionStatus = z.infer<typeof extensionStatusSchema>;

/** POST /api/v1/orders/lookup — which store orders exist and whether they still need documents. */
export const orderLookupRequestSchema = z.object({
	source: storeIdSchema,
	externalOrderIds: z.array(z.string().max(120)).max(200),
});
export const orderLookupResponseSchema = z.object({
	orders: z.array(
		z.object({
			externalOrderId: z.string(),
			orderId: z.string(),
			hasInvoice: z.boolean(),
			dashboardUrl: z.string(),
		}),
	),
});
export type OrderLookupResponse = z.infer<typeof orderLookupResponseSchema>;

/* ---------------------------------------------------------------------------
 * Enrichment ("go get the rest"): the server queues order-detail pages for
 * orders it only knows partially (e.g. from an email); the extension fetches
 * them with the user's store session and submits them as html_snapshot
 * captures (trigger "backfill"), then reports the outcome.
 * ------------------------------------------------------------------------- */

export const MAX_ENRICHMENT_CLAIM = 20;

/** One page the extension should fetch. */
export const enrichmentTaskSchema = z.object({
	id: z.string().uuid(),
	source: storeIdSchema,
	externalOrderId: z.string().max(120),
	url: z.string().url(),
});
export type EnrichmentTask = z.infer<typeof enrichmentTaskSchema>;

/**
 * GET /api/v1/enrichment/next?limit=N[&skipSources=a,b] — claims up to N
 * pending tasks, leaving tasks for `skipSources` stores pending (`limit=0`
 * only counts). `pending` is what is left unclaimed afterwards.
 */
export const enrichmentNextResponseSchema = z.object({
	tasks: z.array(enrichmentTaskSchema),
	pending: z.number().int().nonnegative().default(0),
});
export type EnrichmentNextResponse = z.infer<
	typeof enrichmentNextResponseSchema
>;

export const enrichmentResultStatusSchema = z.enum([
	"done",
	"failed",
	"skipped",
]);
export type EnrichmentResultStatus = z.infer<
	typeof enrichmentResultStatusSchema
>;

/** POST /api/v1/enrichment/{id}/result */
export const enrichmentResultRequestSchema = z.object({
	status: enrichmentResultStatusSchema,
	/** Capture queued with the fetched page, when there was one. */
	captureId: z.string().uuid().optional(),
	error: z.string().max(2000).optional(),
});
export type EnrichmentResultRequest = z.infer<
	typeof enrichmentResultRequestSchema
>;

export const enrichmentResultResponseSchema = z.object({
	id: z.string().uuid(),
	status: enrichmentResultStatusSchema,
});
