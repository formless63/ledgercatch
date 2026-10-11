/**
 * OpenAPI contracts for the agent ledger API (REST v1). Handlers live in
 * src/features/agent-api/rest.server.ts; schemas in
 * src/features/agent-api/schemas.ts. The MCP server at /api/mcp exposes the
 * same operations as tools.
 */
import type { ZodObject, ZodType } from "zod";
import { z } from "zod";
import * as s from "#/features/agent-api/schemas";
import {
	type ApiMethod,
	type ApiOperation,
	type ApiResponseContract,
	defineApiOperation,
} from "./contracts";
import type { ApiPermissionRequirement } from "./permissions";
import { apiErrorSchema } from "./responses";

export const ledgerApiTags = [
	{
		name: "Agent",
		description:
			"Start here. `GET /api/v1/me` returns the key owner, the key's grants and every entity/category/payment-method id. Keys: `X-API-Key: <key>` or `Authorization: Bearer <key>`. Grants: `ledger:read`, `ledger:write`, `admin:write`. The same operations are available as MCP tools at `POST /api/mcp`.",
	},
	{
		name: "Ledger orders",
		description:
			"Orders, line items and triage. Amounts are integer minor units (cents) plus an ISO-4217 currency. `reviewState`: inbox (untriaged) → filed, or ignored.",
	},
	{
		name: "Reimbursements",
		description:
			"Allocations are derived per order and entity. An allocation is reimbursable when the paying entity of the card differs from the allocated entity. Claims group reimbursable allocations.",
	},
	{
		name: "Settings",
		description:
			"Entities, categories and payment methods. Writes need `admin:write`. Creates are idempotent by natural key (name; card brand+last4).",
	},
	{
		name: "Rules",
		description:
			"Automation rules (conditions → entity/category/reimbursable/file/tags). Writes need `admin:write`.",
	},
	{
		name: "Ingest",
		description: "Raw captures (ingest log) and order documents.",
	},
	{
		name: "Accounting",
		description: "Accounting connections, exports and spend insights.",
	},
];

const errors = {
	401: { description: "Missing or invalid API key", schema: apiErrorSchema },
	403: {
		description: "The API key lacks the required permission",
		schema: apiErrorSchema,
	},
	404: { description: "Not found (or not owned)", schema: apiErrorSchema },
	422: { description: "Validation failed", schema: apiErrorSchema },
	429: { description: "API-key rate limit exceeded", schema: apiErrorSchema },
	500: { description: "Unexpected server failure", schema: apiErrorSchema },
} as const;
const bodyErrors = {
	400: { description: "Malformed JSON", schema: apiErrorSchema },
	413: { description: "Request body is too large", schema: apiErrorSchema },
} as const;

const READ: ApiPermissionRequirement = { ledger: ["read"] };
const WRITE: ApiPermissionRequirement = { ledger: ["write"] };
const ADMIN: ApiPermissionRequirement = { admin: ["write"] };

function op(definition: {
	method: ApiMethod;
	path: `/api/v1/${string}`;
	operationId: string;
	summary: string;
	description: string;
	tag: string;
	permissions: ApiPermissionRequirement;
	pathParams?: ZodObject;
	queryParams?: ZodObject;
	requestBody?: ZodType;
	requestContentType?: ApiOperation["requestContentType"];
	ok: Record<number, ApiResponseContract>;
}): ApiOperation {
	const grants = Object.entries(definition.permissions).flatMap(
		([resource, actions]) => (actions ?? []).map((a) => `${resource}:${a}`),
	);
	return defineApiOperation({
		method: definition.method,
		path: definition.path,
		operationId: definition.operationId,
		summary: definition.summary,
		description: `${definition.description}\n\nRequires: ${grants.length ? grants.map((g) => `\`${g}\``).join(", ") : "any valid API key"}.`,
		tags: [definition.tag],
		pathParams: definition.pathParams,
		queryParams: definition.queryParams,
		requestBody: definition.requestBody,
		requestContentType: definition.requestContentType,
		machineAuth: true,
		permissions: definition.permissions,
		responses: {
			...definition.ok,
			...(definition.requestBody
				? (bodyErrors as Record<number, ApiResponseContract>)
				: {}),
			...errors,
		},
	});
}

export const ledgerApiOperations: ApiOperation[] = [
	op({
		method: "GET",
		path: "/api/v1/me",
		operationId: "getMe",
		summary: "Who am I (start here)",
		description:
			"Key owner, this key's grants, active entities, categories and payment methods (ids for every other call), inbox count, and links to the OpenAPI document and MCP endpoint.",
		tag: "Agent",
		permissions: {},
		ok: {
			200: { description: "Identity and reference data", schema: s.meResponse },
		},
	}),

	/* ── orders ── */
	op({
		method: "GET",
		path: "/api/v1/orders",
		operationId: "listLedgerOrders",
		summary: "List and search orders",
		description:
			"Filter by view (inbox/filed/ignored/all), entity (or `unassigned`), store, status, reimbursement state, missing invoice and order-date range; `q` searches merchant, order number, items and notes. Paginate with limit/offset; `total` is the full match count.",
		tag: "Ledger orders",
		permissions: READ,
		queryParams: s.orderListQuery,
		ok: {
			200: { description: "A page of orders", schema: s.orderListResponse },
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/orders",
		operationId: "createLedgerOrders",
		summary: "Enter structured orders",
		description:
			"Each order becomes a capture on the `agent` channel and is ingested like any other source: merged by (source, externalOrderId), rules applied to new orders, allocations computed. Send an `Idempotency-Key` header to make retries safe (stored as the capture source reference); without it the payload hash deduplicates identical posts. With `wait: true` (default) the response includes order ids; 202 means ingestion is still queued — poll `GET /api/v1/captures/{captureId}`. Optional per-order `triage` (entity, category, reviewState, tags…) is applied after ingest.",
		tag: "Ledger orders",
		permissions: WRITE,
		requestBody: s.createOrdersBody,
		ok: {
			200: {
				description: "All orders were duplicates",
				schema: s.createOrdersResponse,
			},
			201: { description: "Orders ingested", schema: s.createOrdersResponse },
			202: {
				description: "Accepted; still processing",
				schema: s.createOrdersResponse,
			},
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/orders/bulk",
		operationId: "bulkUpdateLedgerOrders",
		summary: "Bulk update orders",
		description:
			'Apply entity / category / reimbursableOverride / reviewState to up to 500 orders. Use `reviewState: "filed"` to file, `"ignored"` to ignore.',
		tag: "Ledger orders",
		permissions: WRITE,
		requestBody: s.bulkOrdersBody,
		ok: { 200: { description: "Orders updated", schema: s.updatedSchema } },
	}),
	op({
		method: "GET",
		path: "/api/v1/orders/{orderId}",
		operationId: "getLedgerOrder",
		summary: "Get order detail",
		description:
			"Order with items (per-item entity/category overrides), shipments, allocations, documents, provenance captures, audit history and exports.",
		tag: "Ledger orders",
		permissions: READ,
		pathParams: s.orderIdParams,
		ok: { 200: { description: "Order detail", schema: s.orderDetailResponse } },
	}),
	op({
		method: "PATCH",
		path: "/api/v1/orders/{orderId}",
		operationId: "updateLedgerOrder",
		summary: "Update / assign / file an order",
		description:
			"Partial update: entityId, categoryId, paymentMethodId, reimbursableOverride (true/false/null = auto), reviewState, notes, tags (replace) or addTags/removeTags, merchantName. Allocations recompute. Returns the updated order detail.",
		tag: "Ledger orders",
		permissions: WRITE,
		pathParams: s.orderIdParams,
		requestBody: s.orderPatchBody,
		ok: {
			200: { description: "Updated order", schema: s.orderDetailResponse },
		},
	}),
	op({
		method: "PATCH",
		path: "/api/v1/orders/{orderId}/items/{itemId}",
		operationId: "updateLedgerOrderItem",
		summary: "Assign a line item",
		description:
			"Override one item's entity and/or category (splits the order). `entityId: null` returns it to the order's primary entity.",
		tag: "Ledger orders",
		permissions: WRITE,
		pathParams: s.orderItemParams,
		requestBody: s.itemPatchBody,
		ok: { 200: { description: "Item updated", schema: s.okSchema } },
	}),
	op({
		method: "POST",
		path: "/api/v1/orders/{orderId}/split",
		operationId: "splitLedgerOrder",
		summary: "Split an order by items",
		description:
			"Set several item overrides at once; returns recomputed allocations.",
		tag: "Ledger orders",
		permissions: WRITE,
		pathParams: s.orderIdParams,
		requestBody: s.splitOrderBody,
		ok: {
			200: {
				description: "Items updated",
				schema: z.object({
					updated: z.number().int(),
					allocations: z.array(s.allocationSchema),
				}),
			},
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/orders/{orderId}/rules",
		operationId: "explainLedgerOrderRules",
		summary: "Explain matching rules",
		description: "Which enabled rules match the order and the merged actions.",
		tag: "Rules",
		permissions: READ,
		pathParams: s.orderIdParams,
		ok: {
			200: {
				description: "Rule evaluation",
				schema: s.looseResponse("Matched rule ids and actions"),
			},
		},
	}),

	/* ── documents ── */
	op({
		method: "GET",
		path: "/api/v1/orders/{orderId}/documents",
		operationId: "listLedgerOrderDocuments",
		summary: "List order documents",
		description:
			"Invoices, receipts and other files attached to an order, with download URLs.",
		tag: "Ingest",
		permissions: READ,
		pathParams: s.orderIdParams,
		ok: {
			200: {
				description: "Documents",
				schema: s.listOf("documents", "Document"),
			},
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/orders/{orderId}/documents",
		operationId: "uploadLedgerOrderDocument",
		summary: "Attach a document",
		description:
			"Multipart upload (`file`, optional `kind` default invoice, optional `fileName`), up to 25 MiB. Deduplicated by SHA-256 (natural idempotency); an unattached duplicate is attached to this order.",
		tag: "Ingest",
		permissions: WRITE,
		pathParams: s.orderIdParams,
		requestBody: s.documentUploadForm,
		requestContentType: "multipart/form-data",
		ok: {
			200: {
				description: "Duplicate document",
				schema: s.documentUploadResponse,
			},
			201: { description: "Document stored", schema: s.documentUploadResponse },
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/documents/{documentId}",
		operationId: "downloadLedgerDocument",
		summary: "Download a document",
		description:
			"Returns the stored bytes as an attachment (HTML is served as text/plain).",
		tag: "Ingest",
		permissions: READ,
		pathParams: s.documentIdParams,
		ok: { 200: { description: "Document bytes" } },
	}),

	/* ── reimbursements & claims ── */
	op({
		method: "GET",
		path: "/api/v1/reimbursements",
		operationId: "getReimbursements",
		summary: "Open reimbursements",
		description:
			"Reimbursable allocations that are pending, submitted or rejected (with paying entity and payment method), plus the 100 most recent claims.",
		tag: "Reimbursements",
		permissions: READ,
		ok: {
			200: {
				description: "Open allocations and claims",
				schema: s.looseResponse("{ open, claims }"),
			},
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/reimbursements",
		operationId: "setReimbursementStatus",
		summary: "Set reimbursement status",
		description:
			"Set status on allocations (`none` = not reimbursable; any other status marks them reimbursable). Idempotent.",
		tag: "Reimbursements",
		permissions: WRITE,
		requestBody: s.reimbursementBody,
		ok: {
			200: { description: "Allocations updated", schema: s.updatedSchema },
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/claims",
		operationId: "listClaims",
		summary: "List claims",
		description: "Claims newest first, optional status filter, paginated.",
		tag: "Reimbursements",
		permissions: READ,
		queryParams: s.claimListQuery,
		ok: {
			200: {
				description: "A page of claims",
				schema: s.pagedListOf("claims", "Claim"),
			},
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/claims",
		operationId: "createClaim",
		summary: "Create claims",
		description:
			"Groups reimbursable allocations into one claim per payer/owing entity/currency and marks them submitted. Natural idempotency: if every allocation is already on a claim, those claim ids are returned with 200.",
		tag: "Reimbursements",
		permissions: WRITE,
		requestBody: s.createClaimBody,
		ok: {
			200: {
				description: "Already claimed",
				schema: z.object({
					claimIds: z.array(z.string()),
					created: z.boolean(),
				}),
			},
			201: {
				description: "Claims created",
				schema: z.object({
					claimIds: z.array(z.string()),
					created: z.boolean(),
				}),
			},
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/claims/{claimId}",
		operationId: "getClaim",
		summary: "Get a claim",
		description: "A claim and its allocation lines.",
		tag: "Reimbursements",
		permissions: READ,
		pathParams: s.claimIdParams,
		ok: {
			200: {
				description: "Claim",
				schema: s.looseResponse("{ claim, lines }"),
			},
		},
	}),
	op({
		method: "PATCH",
		path: "/api/v1/claims/{claimId}",
		operationId: "updateClaimStatus",
		summary: "Set claim status",
		description:
			"`paid` marks its allocations reimbursed; `void` releases them back to pending; `submitted`/`draft` keep them submitted. Returns the claim.",
		tag: "Reimbursements",
		permissions: WRITE,
		pathParams: s.claimIdParams,
		requestBody: s.claimPatchBody,
		ok: {
			200: {
				description: "Claim",
				schema: s.looseResponse("{ claim, lines }"),
			},
		},
	}),

	/* ── settings ── */
	...settingsOperations(
		"entities",
		"entityId",
		"Entity",
		s.entityIdParams,
		s.entityCreateBody,
		s.entityPatchBody,
		"An entity with the same name (case-insensitive) is returned instead of duplicating.",
	),
	...settingsOperations(
		"categories",
		"categoryId",
		"Category",
		s.categoryIdParams,
		s.categoryCreateBody,
		s.categoryPatchBody,
		"A category with the same name in the same entity scope is returned instead of duplicating.",
	),
	...settingsOperations(
		"payment-methods",
		"paymentMethodId",
		"PaymentMethod",
		s.paymentMethodIdParams,
		s.paymentMethodCreateBody,
		s.paymentMethodPatchBody,
		"The same card (brand + last4), or the same label when last4 is omitted, is returned instead of duplicating. `payingEntityId` drives reimbursement.",
	),

	/* ── rules ── */
	op({
		method: "GET",
		path: "/api/v1/rules",
		operationId: "listRules",
		summary: "List rules",
		description: "Rules in priority order with match statistics.",
		tag: "Rules",
		permissions: READ,
		ok: { 200: { description: "Rules", schema: s.listOf("rules", "Rule") } },
	}),
	op({
		method: "POST",
		path: "/api/v1/rules",
		operationId: "createRule",
		summary: "Create a rule",
		description:
			"Conditions `{field, op, value}`: field ∈ source, merchant, item_title, sku, payment_last4, total (minor units), currency; op ∈ equals, contains, matches (regex), gt, lt. Actions: entityId, categoryId, reimbursable (auto|yes|no), file, tags. A rule with the same name is returned unchanged (200).",
		tag: "Rules",
		permissions: ADMIN,
		requestBody: s.ruleBody,
		ok: {
			200: { description: "Existing rule", schema: s.idCreatedSchema },
			201: { description: "Rule created", schema: s.idCreatedSchema },
		},
	}),
	op({
		method: "PUT",
		path: "/api/v1/rules/{ruleId}",
		operationId: "replaceRule",
		summary: "Replace a rule",
		description:
			"Full replacement of name, enabled, priority, match, conditions, actions.",
		tag: "Rules",
		permissions: ADMIN,
		pathParams: s.ruleIdParams,
		requestBody: s.ruleBody,
		ok: { 200: { description: "Rule replaced", schema: s.okSchema } },
	}),
	op({
		method: "DELETE",
		path: "/api/v1/rules/{ruleId}",
		operationId: "deleteRule",
		summary: "Delete a rule",
		description: "Deletes the rule; assignments it already made stay.",
		tag: "Rules",
		permissions: ADMIN,
		pathParams: s.ruleIdParams,
		ok: { 200: { description: "Rule deleted", schema: s.okSchema } },
	}),
	op({
		method: "POST",
		path: "/api/v1/rules/dry-run",
		operationId: "dryRunRule",
		summary: "Dry-run a draft rule",
		description:
			"Which of the ~300 most recent orders the draft would match (no changes).",
		tag: "Rules",
		permissions: READ,
		requestBody: s.ruleDryRunBody,
		ok: {
			200: {
				description: "Matches",
				schema: z.object({
					scanned: z.number(),
					matchCount: z.number(),
					matches: z.array(z.looseObject({ id: z.string() })),
				}),
			},
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/rules/apply",
		operationId: "applyRulesToInbox",
		summary: "Apply rules to the inbox",
		description: "Re-runs enabled rules over every inbox order.",
		tag: "Rules",
		permissions: WRITE,
		ok: {
			200: {
				description: "Orders changed",
				schema: z.object({ changed: z.number() }),
			},
		},
	}),

	/* ── captures ── */
	op({
		method: "GET",
		path: "/api/v1/captures/list",
		operationId: "listCaptures",
		summary: "List captures",
		description:
			"Ingest log newest first: status (pending, parsed, no_orders, needs_review, failed, ignored), source, channel filters; paginated.",
		tag: "Ingest",
		permissions: READ,
		queryParams: s.captureListQuery,
		ok: {
			200: {
				description: "A page of captures",
				schema: s.pagedListOf("captures", "Capture"),
			},
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/captures/{captureId}",
		operationId: "getCapture",
		summary: "Get a capture",
		description:
			"Capture metadata, linked orders and (unless includeBody=false) the raw body truncated at 400k characters.",
		tag: "Ingest",
		permissions: READ,
		pathParams: s.captureIdParams,
		queryParams: s.captureGetQuery,
		ok: { 200: { description: "Capture", schema: s.looseResponse("Capture") } },
	}),
	op({
		method: "POST",
		path: "/api/v1/captures/{captureId}/reprocess",
		operationId: "reprocessCapture",
		summary: "Re-process a capture",
		description: "Queues the capture for parsing again.",
		tag: "Ingest",
		permissions: WRITE,
		pathParams: s.captureIdParams,
		ok: {
			200: { description: "Queued", schema: z.object({ queued: z.number() }) },
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/captures/{captureId}/ignore",
		operationId: "ignoreCapture",
		summary: "Ignore a capture",
		description: "Marks the capture ignored.",
		tag: "Ingest",
		permissions: WRITE,
		pathParams: s.captureIdParams,
		ok: { 200: { description: "Ignored", schema: s.okSchema } },
	}),

	/* ── accounting ── */
	op({
		method: "POST",
		path: "/api/v1/exports",
		operationId: "queueExports",
		summary: "Queue accounting exports",
		description:
			"Queues allocations (or all allocations of orderIds) for every enabled connection of their entity. Already-sent exports are skipped unless `force`. Asynchronous (pg-boss).",
		tag: "Accounting",
		permissions: WRITE,
		requestBody: s.queueExportBody,
		ok: {
			202: {
				description: "Queued",
				schema: z.object({ queued: z.number(), skipped: z.number() }),
			},
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/connections",
		operationId: "listConnections",
		summary: "List accounting connections",
		description:
			"Provider, entity, status and non-secret config. Secrets are never returned.",
		tag: "Accounting",
		permissions: READ,
		ok: {
			200: {
				description: "Connections",
				schema: s.listOf("connections", "Connection"),
			},
		},
	}),
	op({
		method: "POST",
		path: "/api/v1/connections/{connectionId}/test",
		operationId: "testConnection",
		summary: "Test a connection",
		description:
			"Checks credentials against the provider and records the result.",
		tag: "Accounting",
		permissions: ADMIN,
		pathParams: s.connectionIdParams,
		ok: {
			200: {
				description: "Test result",
				schema: z.object({
					ok: z.boolean(),
					summary: z.string().optional(),
					error: z.string().optional(),
				}),
			},
		},
	}),
	op({
		method: "GET",
		path: "/api/v1/insights",
		operationId: "getInsights",
		summary: "Spend insights",
		description:
			"Spend by month/entity, entity, store, category; reimbursement totals; missing-invoice counts. Default range: last 365 days.",
		tag: "Accounting",
		permissions: READ,
		queryParams: s.insightsQuery,
		ok: {
			200: {
				description: "Insights",
				schema: s.looseResponse("Insight series"),
			},
		},
	}),
];

function settingsOperations(
	resource: "entities" | "categories" | "payment-methods",
	idParam: string,
	name: string,
	params: ZodObject,
	createBody: ZodType,
	patchBody: ZodType,
	idempotency: string,
): ApiOperation[] {
	const label = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	const plural = resource.replace("-", " ");
	return [
		op({
			method: "GET",
			path: `/api/v1/${resource}`,
			operationId: `list${name.replace(/y$/, "ie")}s`,
			summary: `List ${plural}`,
			description: `Active ${plural} (\`includeArchived=true\` for all).`,
			tag: "Settings",
			permissions: READ,
			queryParams: s.listQuery,
			ok: {
				200: {
					description: plural,
					schema: s.listOf(
						resource === "payment-methods" ? "paymentMethods" : resource,
						name,
					),
				},
			},
		}),
		op({
			method: "POST",
			path: `/api/v1/${resource}`,
			operationId: `create${name}`,
			summary: `Create ${label}`,
			description: idempotency,
			tag: "Settings",
			permissions: ADMIN,
			requestBody: createBody,
			ok: {
				200: { description: `Existing ${label}`, schema: s.idCreatedSchema },
				201: { description: `${name} created`, schema: s.idCreatedSchema },
			},
		}),
		op({
			method: "PATCH",
			path: `/api/v1/${resource}/{${idParam}}`,
			operationId: `update${name}`,
			summary: `Update ${label}`,
			description: `Partial update; omitted fields keep their values. \`archived: true\` archives.`,
			tag: "Settings",
			permissions: ADMIN,
			pathParams: params,
			requestBody: patchBody,
			ok: { 200: { description: `${name} updated`, schema: s.okSchema } },
		}),
	];
}
