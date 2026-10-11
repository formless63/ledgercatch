/**
 * OpenAPI contracts for the browser-extension machine API. Handlers live in
 * src/features/ledger/extension-api.server.ts; payload schemas are shared with
 * the extension through src/shared/capture.ts.
 */
import { z } from "zod";
import {
	captureEnvelopeSchema,
	captureResponseSchema,
	documentUploadMetaSchema,
	extensionStatusSchema,
	orderLookupRequestSchema,
	orderLookupResponseSchema,
} from "#/shared/capture";
import { type ApiOperation, defineApiOperation } from "./contracts";
import { apiErrorSchema } from "./responses";

export const apiTags = [
	{ name: "Extension", description: "Browser extension connection checks." },
	{ name: "Captures", description: "Raw order captures and documents." },
	{ name: "Orders", description: "Tracked order lookups." },
];

const authErrors = {
	401: { description: "Missing or invalid API key", schema: apiErrorSchema },
	403: {
		description: "Insufficient API-key permissions",
		schema: apiErrorSchema,
	},
	429: { description: "API-key rate limit exceeded", schema: apiErrorSchema },
	500: { description: "Unexpected server failure", schema: apiErrorSchema },
} as const;

const bodyErrors = {
	400: { description: "Malformed request", schema: apiErrorSchema },
	413: { description: "Request body is too large", schema: apiErrorSchema },
	422: { description: "Request validation failed", schema: apiErrorSchema },
} as const;

export const documentUploadFormSchema = z
	.object({
		meta: z.string().meta({
			description: "JSON-encoded document metadata.",
			contentMediaType: "application/json",
			contentSchema: documentUploadMetaSchema,
		}),
		file: z.string().meta({
			description: "Document binary (PDF or image), up to 25 MiB.",
			contentMediaType: "application/octet-stream",
		}),
	})
	.meta({ id: "DocumentUploadForm" });

export const documentUploadResponseSchema = z.object({
	documentId: z.string(),
	duplicate: z.boolean(),
	orderId: z.string().nullable(),
});

export const extensionStatusOperation = defineApiOperation({
	method: "GET",
	path: "/api/v1/extension/status",
	operationId: "getExtensionStatus",
	summary: "Check the extension connection",
	description: "Verifies the API key and returns the owning user.",
	tags: ["Extension"],
	machineAuth: true,
	permissions: {},
	responses: {
		200: { description: "Key is valid", schema: extensionStatusSchema },
		...authErrors,
	},
});

export const createCaptureOperation = defineApiOperation({
	method: "POST",
	path: "/api/v1/captures",
	operationId: "createCapture",
	summary: "Submit a raw capture",
	description:
		"Stores an immutable raw capture and queues parsing. Idempotent by captureId and content hash.",
	tags: ["Captures"],
	requestBody: captureEnvelopeSchema,
	machineAuth: true,
	permissions: { captures: ["write"] },
	responses: {
		200: {
			description: "Duplicate capture (already stored)",
			schema: captureResponseSchema,
		},
		201: { description: "Capture accepted", schema: captureResponseSchema },
		...bodyErrors,
		...authErrors,
	},
});

export const uploadDocumentOperation = defineApiOperation({
	method: "POST",
	path: "/api/v1/documents",
	operationId: "uploadDocument",
	summary: "Upload an order document",
	description:
		"Multipart upload (`meta` JSON + `file`). Links to an order by source and externalOrderId when possible; deduplicated by content hash.",
	tags: ["Captures"],
	requestBody: documentUploadFormSchema,
	requestContentType: "multipart/form-data",
	machineAuth: true,
	permissions: { captures: ["write"] },
	responses: {
		200: {
			description: "Duplicate document (already stored)",
			schema: documentUploadResponseSchema,
		},
		201: {
			description: "Document stored",
			schema: documentUploadResponseSchema,
		},
		...bodyErrors,
		...authErrors,
	},
});

export const lookupOrdersOperation = defineApiOperation({
	method: "POST",
	path: "/api/v1/orders/lookup",
	operationId: "lookupOrders",
	summary: "Look up tracked store orders",
	description:
		"Returns which store order IDs are already tracked and whether they have an invoice or receipt.",
	tags: ["Orders"],
	requestBody: orderLookupRequestSchema,
	machineAuth: true,
	permissions: { orders: ["read"] },
	responses: {
		200: { description: "Tracked orders", schema: orderLookupResponseSchema },
		...bodyErrors,
		...authErrors,
	},
});

export const apiOperations: ApiOperation[] = [
	extensionStatusOperation,
	createCaptureOperation,
	uploadDocumentOperation,
	lookupOrdersOperation,
];
