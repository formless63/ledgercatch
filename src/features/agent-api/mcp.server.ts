/**
 * MCP server (Streamable HTTP, stateless, JSON responses) at POST /api/mcp.
 * Auth: Authorization: Bearer <api key> or X-API-Key — the same API Platform
 * keys as REST. Each tool enforces the same grants as its REST endpoint.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hasRequiredPermissions } from "#/integrations/api-platform/permissions";
import type { ApiPrincipal } from "#/integrations/api-platform/principal.server";
import { ApiHttpError } from "#/integrations/api-platform/responses";
import { appName } from "#/lib/app-name";
import { AGENT_GUIDE } from "./guide";
import {
	authenticate,
	errorResponse,
	readBoundedText,
	toApiError,
} from "./http.server";
import {
	PERMISSION_LABELS,
	PERMISSIONS,
	type PermissionLevel,
} from "./permissions";
import * as schemas from "./schemas";
import * as service from "./service.server";

const MAX_MCP_BODY = 10 * 1024 * 1024;

type ToolAnnotations = {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
};

export type AgentTool = {
	name: string;
	title: string;
	description: string;
	level: PermissionLevel;
	input: z.ZodType;
	annotations: ToolAnnotations;
	run: (principal: ApiPrincipal, input: unknown) => Promise<unknown>;
};

function tool<S extends z.ZodType>(definition: {
	name: string;
	title: string;
	description: string;
	level: PermissionLevel;
	input: S;
	annotations?: ToolAnnotations;
	run: (principal: ApiPrincipal, input: z.output<S>) => Promise<unknown>;
}): AgentTool {
	return {
		...definition,
		annotations:
			definition.annotations ??
			(definition.level === "read" || definition.level === "any"
				? { readOnlyHint: true }
				: {}),
		run: (principal, input) => definition.run(principal, input as z.output<S>),
	};
}

const empty = z.object({});
const mcpLimit = (fallback: number, max: number) =>
	z.number().int().min(1).max(max).default(fallback);
const orderRef = z.object({ orderId: schemas.uuid });

export const agentTools: AgentTool[] = [
	tool({
		name: "get_started",
		title: "Workflow guide",
		description:
			"Read first. Explains orders, entities, allocations, reimbursement/claims semantics and the recommended triage workflow.",
		level: "any",
		input: empty,
		run: async () => ({ guide: AGENT_GUIDE }),
	}),
	tool({
		name: "whoami",
		title: "Who am I",
		description:
			"The key owner, this key's permissions, and the entity / category / payment-method ids you need for every other tool. Call this before triaging.",
		level: "any",
		input: empty,
		run: (principal) => service.getMe(principal),
	}),
	tool({
		name: "list_orders",
		title: "List orders",
		description:
			"Search and filter orders (view, entity, store, status, reimbursement, missing invoice, date range, full-text q). Paginated with limit/offset; response includes total. Amounts are minor units.",
		level: "read",
		input: schemas.orderListQuery.extend({
			missingInvoice: z.boolean().optional(),
			limit: mcpLimit(25, 200),
		}),
		run: (principal, input) => service.listOrders(principal.userId, input),
	}),
	tool({
		name: "list_inbox",
		title: "List inbox",
		description:
			"Untriaged orders (reviewState=inbox), newest first. Assign them with update_order / bulk_update_orders and file them.",
		level: "read",
		input: z.object({
			limit: mcpLimit(25, 200),
			offset: z.number().int().min(0).default(0),
		}),
		run: (principal, input) =>
			service.listOrders(principal.userId, {
				view: "inbox",
				sort: "date_desc",
				limit: input.limit,
				offset: input.offset,
			}),
	}),
	tool({
		name: "get_order",
		title: "Get order",
		description:
			"Full order detail: items (with per-item entity overrides), shipments, allocations, documents, provenance captures, audit history, exports.",
		level: "read",
		input: orderRef,
		run: (principal, input) =>
			service.getOrder(principal.userId, input.orderId),
	}),
	tool({
		name: "create_order",
		title: "Create orders",
		description:
			"Enter structured orders (1–50). Each becomes an agent capture that is parsed like any other source, so rules and allocations apply. Re-posting the same (source, externalOrderId) merges. Pass idempotencyKey to make retries safe. Optional per-order `triage` assigns entity/category/state after ingest.",
		level: "write",
		input: schemas.createOrdersBody.extend({
			idempotencyKey: z
				.string()
				.regex(/^[\x21-\x7e]{1,200}$/)
				.optional()
				.describe("Client key; the same key returns the same captures."),
		}),
		annotations: { idempotentHint: true },
		run: (principal, { idempotencyKey, ...input }) =>
			service.createOrders(principal.userId, input, idempotencyKey ?? null),
	}),
	tool({
		name: "update_order",
		title: "Update order",
		description:
			"Assign entity/category/payment method, force reimbursable (reimbursableOverride), change reviewState (inbox|filed|ignored), notes, tags (or addTags/removeTags), merchant name. Allocations recompute automatically. Returns the updated order.",
		level: "write",
		input: schemas.orderPatchBody.extend({ orderId: schemas.uuid }),
		annotations: { idempotentHint: true },
		run: async (principal, { orderId, ...input }) => {
			await service.updateOrder(principal.userId, orderId, input);
			return service.getOrder(principal.userId, orderId);
		},
	}),
	tool({
		name: "bulk_update_orders",
		title: "Bulk update orders",
		description:
			"Apply the same entity / category / reimbursableOverride / reviewState to up to 500 orders.",
		level: "write",
		input: schemas.bulkOrdersBody,
		annotations: { idempotentHint: true },
		run: (principal, input) =>
			service.bulkUpdateOrders(principal.userId, input),
	}),
	tool({
		name: "file_orders",
		title: "File / ignore orders",
		description:
			"Move orders out of the inbox: reviewState `filed` (default), `ignored` (junk/duplicates, hidden from insights) or back to `inbox`.",
		level: "write",
		input: z.object({
			ids: z.array(schemas.uuid).min(1).max(500),
			reviewState: z.enum(["filed", "ignored", "inbox"]).default("filed"),
		}),
		annotations: { idempotentHint: true },
		run: (principal, input) =>
			service.bulkUpdateOrders(principal.userId, input),
	}),
	tool({
		name: "assign_item",
		title: "Assign line item",
		description:
			"Override one line item's entity and/or category (splits the order across entities). entityId null = back to the order's primary entity.",
		level: "write",
		input: schemas.itemPatchBody.extend({
			orderId: schemas.uuid,
			itemId: schemas.uuid,
		}),
		annotations: { idempotentHint: true },
		run: (principal, { orderId, itemId, ...input }) =>
			service.updateItem(principal.userId, orderId, itemId, input),
	}),
	tool({
		name: "split_order",
		title: "Split order by items",
		description:
			"Set several line-item entity/category overrides at once. Returns the recomputed allocations.",
		level: "write",
		input: schemas.splitOrderBody.extend({ orderId: schemas.uuid }),
		annotations: { idempotentHint: true },
		run: (principal, { orderId, ...input }) =>
			service.splitOrder(principal.userId, orderId, input),
	}),
	tool({
		name: "list_reimbursements",
		title: "Open reimbursements",
		description:
			"Reimbursable allocations still pending/submitted/rejected (with paying entity) and recent claims.",
		level: "read",
		input: empty,
		run: (principal) => service.getReimbursements(principal.userId),
	}),
	tool({
		name: "set_reimbursement",
		title: "Set reimbursement status",
		description:
			"Set reimbursement status on allocations (ids from get_order / list_reimbursements). `none` makes them non-reimbursable.",
		level: "write",
		input: schemas.reimbursementBody,
		annotations: { idempotentHint: true },
		run: (principal, input) =>
			service.setReimbursement(principal.userId, input),
	}),
	tool({
		name: "create_claim",
		title: "Create claim",
		description:
			"Group reimbursable allocations into claims (one per payer/owing entity/currency); marks them submitted. Allocations already on a claim return that claim (idempotent).",
		level: "write",
		input: schemas.createClaimBody,
		annotations: { idempotentHint: true },
		run: (principal, input) => service.createClaim(principal.userId, input),
	}),
	tool({
		name: "list_claims",
		title: "List claims",
		description: "Reimbursement claims, newest first, optional status filter.",
		level: "read",
		input: schemas.claimListQuery.extend({ limit: mcpLimit(25, 200) }),
		run: (principal, input) => service.listClaims(principal.userId, input),
	}),
	tool({
		name: "get_claim",
		title: "Get claim",
		description: "One claim with its allocation lines.",
		level: "read",
		input: z.object({ claimId: schemas.uuid }),
		run: (principal, input) =>
			service.getClaim(principal.userId, input.claimId),
	}),
	tool({
		name: "set_claim_status",
		title: "Set claim status",
		description:
			"draft | submitted | paid (allocations → reimbursed) | void (allocations released to pending).",
		level: "write",
		input: schemas.claimPatchBody.extend({ claimId: schemas.uuid }),
		annotations: { idempotentHint: true },
		run: async (principal, { claimId, ...input }) => {
			await service.setClaimStatus(principal.userId, claimId, input);
			return service.getClaim(principal.userId, claimId);
		},
	}),
	tool({
		name: "list_entities",
		title: "List entities",
		description:
			"Entities (Personal + businesses) expenses can be assigned to.",
		level: "read",
		input: z.object({ includeArchived: z.boolean().optional() }),
		run: (principal, input) => service.listEntities(principal.userId, input),
	}),
	tool({
		name: "list_categories",
		title: "List categories",
		description: "Expense categories (entityId null = shared across entities).",
		level: "read",
		input: z.object({ includeArchived: z.boolean().optional() }),
		run: (principal, input) => service.listCategories(principal.userId, input),
	}),
	tool({
		name: "list_payment_methods",
		title: "List payment methods",
		description:
			"Cards/accounts with their paying entity (drives reimbursement).",
		level: "read",
		input: z.object({ includeArchived: z.boolean().optional() }),
		run: (principal, input) =>
			service.listPaymentMethods(principal.userId, input),
	}),
	tool({
		name: "upsert_entity",
		title: "Create or update entity",
		description:
			"Without entityId: create (an entity with the same name is returned instead). With entityId: partial update.",
		level: "admin",
		input: schemas.entityPatchBody.extend({
			entityId: schemas.uuid.optional(),
		}),
		run: async (principal, { entityId, ...input }) => {
			if (entityId)
				return service.updateEntity(principal.userId, entityId, input);
			return service.createEntity(
				principal.userId,
				schemas.entityCreateBody.parse(input),
			);
		},
	}),
	tool({
		name: "upsert_category",
		title: "Create or update category",
		description:
			"Without categoryId: create (same name in the same entity scope is returned instead). With categoryId: partial update.",
		level: "admin",
		input: schemas.categoryPatchBody.extend({
			categoryId: schemas.uuid.optional(),
		}),
		run: async (principal, { categoryId, ...input }) => {
			if (categoryId)
				return service.updateCategory(principal.userId, categoryId, input);
			return service.createCategory(
				principal.userId,
				schemas.categoryCreateBody.parse(input),
			);
		},
	}),
	tool({
		name: "upsert_payment_method",
		title: "Create or update payment method",
		description:
			"Without paymentMethodId: create (same brand+last4 is returned instead). With paymentMethodId: partial update. Changing payingEntityId recomputes reimbursement on affected orders.",
		level: "admin",
		input: schemas.paymentMethodPatchBody.extend({
			paymentMethodId: schemas.uuid.optional(),
		}),
		run: async (principal, { paymentMethodId, ...input }) => {
			if (paymentMethodId)
				return service.updatePaymentMethod(
					principal.userId,
					paymentMethodId,
					input,
				);
			return service.createPaymentMethod(
				principal.userId,
				schemas.paymentMethodCreateBody.parse(input),
			);
		},
	}),
	tool({
		name: "list_rules",
		title: "List rules",
		description: "Automation rules in priority order with match counts.",
		level: "read",
		input: empty,
		run: (principal) => service.listRules(principal.userId),
	}),
	tool({
		name: "dry_run_rule",
		title: "Dry-run rule",
		description:
			"Which of the ~300 most recent orders a draft rule would match. Run before upsert_rule.",
		level: "read",
		input: schemas.ruleDryRunBody,
		run: (principal, input) => service.dryRunRule(principal.userId, input),
	}),
	tool({
		name: "upsert_rule",
		title: "Create or replace rule",
		description:
			"Without ruleId: create (a rule with the same name is returned unchanged). With ruleId: full replace. Conditions: field ∈ source|merchant|item_title|sku|payment_last4|total|currency, op ∈ equals|contains|matches(regex)|gt|lt (total in minor units). Actions: entityId, categoryId, reimbursable auto|yes|no, file, tags. Rules run on new orders; use apply_rules for the inbox.",
		level: "admin",
		input: schemas.ruleBody.extend({ ruleId: schemas.uuid.optional() }),
		run: (principal, { ruleId, ...input }) =>
			ruleId
				? service.replaceRule(principal.userId, ruleId, input)
				: service.createRule(principal.userId, input),
	}),
	tool({
		name: "delete_rule",
		title: "Delete rule",
		description: "Delete a rule. Does not undo assignments it already made.",
		level: "admin",
		input: z.object({ ruleId: schemas.uuid }),
		annotations: { destructiveHint: true },
		run: (principal, input) =>
			service.deleteRule(principal.userId, input.ruleId),
	}),
	tool({
		name: "apply_rules",
		title: "Apply rules to inbox",
		description:
			"Re-run enabled rules over every inbox order. Returns how many changed.",
		level: "write",
		input: empty,
		run: (principal) => service.applyRules(principal.userId),
	}),
	tool({
		name: "explain_rules",
		title: "Explain rules for order",
		description:
			"Which rules match one order and the actions they would apply.",
		level: "read",
		input: orderRef,
		run: (principal, input) =>
			service.explainRules(principal.userId, input.orderId),
	}),
	tool({
		name: "list_captures",
		title: "List captures",
		description:
			"Ingest log (raw captures) with parser status/errors. Filter by status (e.g. failed, needs_review), source, channel.",
		level: "read",
		input: schemas.captureListQuery.extend({ limit: mcpLimit(25, 200) }),
		run: (principal, input) => service.listCaptures(principal.userId, input),
	}),
	tool({
		name: "get_capture",
		title: "Get capture",
		description:
			"One capture with linked orders. includeBody=true adds the raw payload (can be large).",
		level: "read",
		input: z.object({
			captureId: schemas.uuid,
			includeBody: z.boolean().default(false),
		}),
		run: (principal, input) =>
			service.getCapture(principal.userId, input.captureId, input.includeBody),
	}),
	tool({
		name: "reprocess_capture",
		title: "Re-process captures",
		description: "Queue captures for parsing again (after parser fixes).",
		level: "write",
		input: schemas.reprocessCapturesBody,
		annotations: { idempotentHint: true },
		run: (principal, input) =>
			service.reprocessCaptures(principal.userId, input.captureIds),
	}),
	tool({
		name: "ignore_capture",
		title: "Ignore capture",
		description: "Mark a capture ignored (it will not be parsed again).",
		level: "write",
		input: z.object({ captureId: schemas.uuid }),
		annotations: { idempotentHint: true },
		run: (principal, input) =>
			service.ignoreCapture(principal.userId, input.captureId),
	}),
	tool({
		name: "list_documents",
		title: "List order documents",
		description:
			"Invoices/receipts/etc. attached to an order, with REST download URLs (GET with the same key).",
		level: "read",
		input: orderRef,
		run: (principal, input) =>
			service.listOrderDocuments(principal.userId, input.orderId),
	}),
	tool({
		name: "upload_document",
		title: "Attach document",
		description:
			"Attach a PDF/image (base64, ≤ ~6 MiB) to an order. Deduplicated by content hash.",
		level: "write",
		input: schemas.documentUploadJson.extend({ orderId: schemas.uuid }),
		annotations: { idempotentHint: true },
		run: (principal, { orderId, base64, ...input }) => {
			const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
			if (bytes.byteLength === 0)
				throw new ApiHttpError(422, "validation_error", "Empty document.");
			return service.uploadOrderDocument(principal.userId, orderId, {
				...input,
				bytes,
			});
		},
	}),
	tool({
		name: "queue_export",
		title: "Queue accounting export",
		description:
			"Push allocations (or every allocation of orderIds) to the accounting connection of their entity. Asynchronous; already-sent exports are skipped unless force=true.",
		level: "write",
		input: schemas.queueExportBody,
		run: (principal, input) => service.queueExport(principal.userId, input),
	}),
	tool({
		name: "list_connections",
		title: "List connections",
		description:
			"Accounting connections (provider, entity, status). Secrets are never returned.",
		level: "read",
		input: empty,
		run: (principal) => service.listConnections(principal.userId),
	}),
	tool({
		name: "test_connection",
		title: "Test connection",
		description: "Check a connection's credentials against the provider.",
		level: "admin",
		input: z.object({ connectionId: schemas.uuid }),
		run: (principal, input) =>
			service.testConnection(principal.userId, input.connectionId),
	}),
	tool({
		name: "get_insights",
		title: "Spend insights",
		description:
			"Spend by month/entity/store/category, reimbursement totals and missing invoices for a date range (default last 365 days).",
		level: "read",
		input: schemas.insightsQuery,
		run: (principal, input) => service.getInsights(principal.userId, input),
	}),
];

function inputJsonSchema(schema: z.ZodType) {
	const { $schema: _schema, ...json } = z.toJSONSchema(schema, {
		io: "input",
		unrepresentable: "any",
	}) as Record<string, unknown>;
	return { type: "object" as const, ...json };
}

let cachedToolList: Array<Record<string, unknown>> | null = null;
export function listToolDescriptors() {
	cachedToolList ??= agentTools.map((t) => ({
		name: t.name,
		title: t.title,
		description: `${t.description} [requires: ${PERMISSION_LABELS[t.level]}]`,
		inputSchema: inputJsonSchema(t.input),
		annotations: { title: t.title, ...t.annotations },
	}));
	return cachedToolList;
}

const toolsByName = new Map(agentTools.map((t) => [t.name, t]));

function textResult(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		...(isError ? { isError: true } : {}),
	};
}

/** Run one tool for a principal; tool failures become `isError` results. */
export async function callAgentTool(
	principal: ApiPrincipal,
	name: string,
	args: unknown,
) {
	const definition = toolsByName.get(name);
	if (!definition)
		throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
	if (
		!hasRequiredPermissions(
			principal.permissions,
			PERMISSIONS[definition.level],
		)
	)
		return textResult(
			{
				error: {
					code: "forbidden",
					message: `This API key lacks ${PERMISSION_LABELS[definition.level]}, required by ${name}.`,
				},
			},
			true,
		);
	const parsed = definition.input.safeParse(args ?? {});
	if (!parsed.success)
		return textResult(
			{
				error: {
					code: "validation_error",
					message: "Invalid tool arguments.",
					details: parsed.error.issues.slice(0, 30).map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				},
			},
			true,
		);
	try {
		return textResult(await definition.run(principal, parsed.data));
	} catch (raw) {
		const error = toApiError(raw);
		if (error instanceof ApiHttpError)
			return textResult(
				{
					error: {
						code: error.code,
						message: error.message,
						details: error.details,
					},
				},
				true,
			);
		console.error(JSON.stringify({ event: "mcp.tool_error", tool: name }));
		return textResult(
			{
				error: {
					code: "internal_error",
					message: "The tool could not be completed.",
				},
			},
			true,
		);
	}
}

export function createAgentMcpServer(principal: ApiPrincipal) {
	const server = new Server(
		{ name: "ledgercatch", version: "1.0.0" },
		{
			capabilities: { tools: {} },
			instructions: `${appName} ledger. Call get_started once, then whoami for entity/category ids. Amounts are integer minor units. Writes are audited as the key owner.`,
		},
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: listToolDescriptors() as never,
	}));
	server.setRequestHandler(CallToolRequestSchema, async (request) =>
		callAgentTool(principal, request.params.name, request.params.arguments),
	);
	return server;
}

export async function handleMcpRequest(request: Request): Promise<Response> {
	if (request.method !== "POST")
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message:
						"Method not allowed: this MCP endpoint is stateless (POST only).",
				},
				id: null,
			}),
			{
				status: 405,
				headers: { allow: "POST", "content-type": "application/json" },
			},
		);
	let principal: ApiPrincipal;
	let body: unknown;
	try {
		principal = await authenticate(request, {});
		const text = await readBoundedText(request, MAX_MCP_BODY);
		try {
			body = JSON.parse(text);
		} catch {
			return Response.json(
				{
					jsonrpc: "2.0",
					error: { code: ErrorCode.ParseError, message: "Parse error" },
					id: null,
				},
				{ status: 400 },
			);
		}
	} catch (error) {
		const response = errorResponse(error);
		if (response.status === 401)
			response.headers.set(
				"www-authenticate",
				'Bearer realm="ledgercatch", error="invalid_token"',
			);
		return response;
	}
	const server = createAgentMcpServer(principal);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	try {
		await server.connect(transport);
		return await transport.handleRequest(request, { parsedBody: body });
	} finally {
		void transport.close().catch(() => {});
		void server.close().catch(() => {});
	}
}
