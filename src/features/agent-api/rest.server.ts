/**
 * REST v1 handlers for the agent API. Routes in src/routes/api/v1/** call
 * these; contracts live in src/integrations/api-platform/ledger.contracts.ts.
 */
import { ApiHttpError } from "#/integrations/api-platform/responses";
import { readMultipart } from "#/lib/multipart.server";
import { documentKindSchema, MAX_DOCUMENT_BYTES } from "#/shared/capture";
import {
	handle,
	idempotencyKey,
	parseParams,
	parseQuery,
	readBody,
} from "./http.server";
import { PERMISSIONS } from "./permissions";
import * as schemas from "./schemas";
import * as service from "./service.server";

type Params = Record<string, string | undefined>;

/* ───────────── identity ───────────── */

export const getMeApi = (request: Request) =>
	handle(request, PERMISSIONS.any, (principal) => service.getMe(principal));

/* ───────────── orders ───────────── */

export const listOrdersApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listOrders(
			principal.userId,
			parseQuery(request, schemas.orderListQuery),
		),
	);

export async function createOrdersApi(request: Request) {
	return handle(request, PERMISSIONS.write, async (principal) => {
		const key = idempotencyKey(request);
		const body = await readBody(request, schemas.createOrdersBody, 1_048_576);
		const result = await service.createOrders(principal.userId, body, key);
		const status = result.pending
			? 202
			: result.results.some((row) => !row.duplicate)
				? 201
				: 200;
		return Response.json(result, { status });
	});
}

export const getOrderApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.getOrder(
			principal.userId,
			parseParams(schemas.orderIdParams, params).orderId,
		),
	);

export const updateOrderApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.write, async (principal) => {
		const { orderId } = parseParams(schemas.orderIdParams, params);
		const body = await readBody(request, schemas.orderPatchBody);
		await service.updateOrder(principal.userId, orderId, body);
		return service.getOrder(principal.userId, orderId);
	});

export const bulkUpdateOrdersApi = (request: Request) =>
	handle(request, PERMISSIONS.write, async (principal) =>
		service.bulkUpdateOrders(
			principal.userId,
			await readBody(request, schemas.bulkOrdersBody),
		),
	);

export const updateOrderItemApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.write, async (principal) => {
		const { orderId, itemId } = parseParams(schemas.orderItemParams, params);
		const body = await readBody(request, schemas.itemPatchBody);
		return service.updateItem(principal.userId, orderId, itemId, body);
	});

export const splitOrderApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.write, async (principal) => {
		const { orderId } = parseParams(schemas.orderIdParams, params);
		const body = await readBody(request, schemas.splitOrderBody);
		return service.splitOrder(principal.userId, orderId, body);
	});

export const explainOrderRulesApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.explainRules(
			principal.userId,
			parseParams(schemas.orderIdParams, params).orderId,
		),
	);

/* ───────────── documents ───────────── */

export const listOrderDocumentsApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listOrderDocuments(
			principal.userId,
			parseParams(schemas.orderIdParams, params).orderId,
		),
	);

export async function uploadOrderDocumentApi(request: Request, params: Params) {
	return handle(request, PERMISSIONS.write, async (principal) => {
		const { orderId } = parseParams(schemas.orderIdParams, params);
		let form: FormData;
		try {
			form = await readMultipart(request, MAX_DOCUMENT_BYTES + 256 * 1024);
		} catch (error) {
			if (error instanceof ApiHttpError) throw error;
			throw new ApiHttpError(
				400,
				"bad_request",
				"Expected multipart/form-data.",
			);
		}
		const file = form.get("file");
		if (!(file instanceof Blob))
			throw new ApiHttpError(400, "bad_request", "Field `file` is required.");
		if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES)
			throw new ApiHttpError(
				413,
				"payload_too_large",
				"Document is empty or too large.",
			);
		const kind = documentKindSchema.safeParse(form.get("kind") ?? "invoice");
		if (!kind.success)
			throw new ApiHttpError(422, "validation_error", "Invalid document kind.");
		const rawName = form.get("fileName");
		const fileName =
			(typeof rawName === "string" && rawName.trim()) ||
			(file instanceof File ? file.name : "") ||
			"document";
		const stored = await service.uploadOrderDocument(
			principal.userId,
			orderId,
			{
				bytes: new Uint8Array(await file.arrayBuffer()),
				contentType: file.type || "application/octet-stream",
				fileName,
				kind: kind.data,
			},
		);
		return Response.json(stored, { status: stored.duplicate ? 200 : 201 });
	});
}

export const downloadDocumentApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.downloadDocument(
			principal.userId,
			parseParams(schemas.documentIdParams, params).documentId,
		),
	);

/* ───────────── reimbursements & claims ───────────── */

export const getReimbursementsApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.getReimbursements(principal.userId),
	);

export const setReimbursementApi = (request: Request) =>
	handle(request, PERMISSIONS.write, async (principal) =>
		service.setReimbursement(
			principal.userId,
			await readBody(request, schemas.reimbursementBody),
		),
	);

export const listClaimsApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listClaims(
			principal.userId,
			parseQuery(request, schemas.claimListQuery),
		),
	);

export async function createClaimApi(request: Request) {
	return handle(request, PERMISSIONS.write, async (principal) => {
		const result = await service.createClaim(
			principal.userId,
			await readBody(request, schemas.createClaimBody),
		);
		return Response.json(result, { status: result.created ? 201 : 200 });
	});
}

export const getClaimApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.getClaim(
			principal.userId,
			parseParams(schemas.claimIdParams, params).claimId,
		),
	);

export const updateClaimApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.write, async (principal) => {
		const { claimId } = parseParams(schemas.claimIdParams, params);
		const body = await readBody(request, schemas.claimPatchBody);
		await service.setClaimStatus(principal.userId, claimId, body);
		return service.getClaim(principal.userId, claimId);
	});

/* ───────────── entities / categories / payment methods ───────────── */

const created = (result: { created: boolean }) =>
	Response.json(result, { status: result.created ? 201 : 200 });

export const listEntitiesApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listEntities(
			principal.userId,
			parseQuery(request, schemas.listQuery),
		),
	);

export const createEntityApi = (request: Request) =>
	handle(request, PERMISSIONS.admin, async (principal) =>
		created(
			await service.createEntity(
				principal.userId,
				await readBody(request, schemas.entityCreateBody),
			),
		),
	);

export const updateEntityApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.admin, async (principal) => {
		const { entityId } = parseParams(schemas.entityIdParams, params);
		return service.updateEntity(
			principal.userId,
			entityId,
			await readBody(request, schemas.entityPatchBody),
		);
	});

export const listCategoriesApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listCategories(
			principal.userId,
			parseQuery(request, schemas.listQuery),
		),
	);

export const createCategoryApi = (request: Request) =>
	handle(request, PERMISSIONS.admin, async (principal) =>
		created(
			await service.createCategory(
				principal.userId,
				await readBody(request, schemas.categoryCreateBody),
			),
		),
	);

export const updateCategoryApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.admin, async (principal) => {
		const { categoryId } = parseParams(schemas.categoryIdParams, params);
		return service.updateCategory(
			principal.userId,
			categoryId,
			await readBody(request, schemas.categoryPatchBody),
		);
	});

export const listPaymentMethodsApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listPaymentMethods(
			principal.userId,
			parseQuery(request, schemas.listQuery),
		),
	);

export const createPaymentMethodApi = (request: Request) =>
	handle(request, PERMISSIONS.admin, async (principal) =>
		created(
			await service.createPaymentMethod(
				principal.userId,
				await readBody(request, schemas.paymentMethodCreateBody),
			),
		),
	);

export const updatePaymentMethodApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.admin, async (principal) => {
		const { paymentMethodId } = parseParams(
			schemas.paymentMethodIdParams,
			params,
		);
		return service.updatePaymentMethod(
			principal.userId,
			paymentMethodId,
			await readBody(request, schemas.paymentMethodPatchBody),
		);
	});

/* ───────────── rules ───────────── */

export const listRulesApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listRules(principal.userId),
	);

export const createRuleApi = (request: Request) =>
	handle(request, PERMISSIONS.admin, async (principal) =>
		created(
			await service.createRule(
				principal.userId,
				await readBody(request, schemas.ruleBody),
			),
		),
	);

export const replaceRuleApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.admin, async (principal) => {
		const { ruleId } = parseParams(schemas.ruleIdParams, params);
		return service.replaceRule(
			principal.userId,
			ruleId,
			await readBody(request, schemas.ruleBody),
		);
	});

export const deleteRuleApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.admin, (principal) =>
		service.deleteRule(
			principal.userId,
			parseParams(schemas.ruleIdParams, params).ruleId,
		),
	);

export const dryRunRuleApi = (request: Request) =>
	handle(request, PERMISSIONS.read, async (principal) =>
		service.dryRunRule(
			principal.userId,
			await readBody(request, schemas.ruleDryRunBody),
		),
	);

export const applyRulesApi = (request: Request) =>
	handle(request, PERMISSIONS.write, (principal) =>
		service.applyRules(principal.userId),
	);

/* ───────────── captures ───────────── */

export const listCapturesApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listCaptures(
			principal.userId,
			parseQuery(request, schemas.captureListQuery),
		),
	);

export const getCaptureApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.getCapture(
			principal.userId,
			parseParams(schemas.captureIdParams, params).captureId,
			parseQuery(request, schemas.captureGetQuery).includeBody ?? true,
		),
	);

export const reprocessCaptureApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.write, (principal) =>
		service.reprocessCaptures(principal.userId, [
			parseParams(schemas.captureIdParams, params).captureId,
		]),
	);

export const ignoreCaptureApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.write, (principal) =>
		service.ignoreCapture(
			principal.userId,
			parseParams(schemas.captureIdParams, params).captureId,
		),
	);

/* ───────────── exports, connections, insights ───────────── */

export const queueExportApi = (request: Request) =>
	handle(
		request,
		PERMISSIONS.write,
		async (principal) =>
			service.queueExport(
				principal.userId,
				await readBody(request, schemas.queueExportBody),
			),
		202,
	);

export const listConnectionsApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.listConnections(principal.userId),
	);

export const testConnectionApi = (request: Request, params: Params) =>
	handle(request, PERMISSIONS.admin, (principal) =>
		service.testConnection(
			principal.userId,
			parseParams(schemas.connectionIdParams, params).connectionId,
		),
	);

export const getInsightsApi = (request: Request) =>
	handle(request, PERMISSIONS.read, (principal) =>
		service.getInsights(
			principal.userId,
			parseQuery(request, schemas.insightsQuery),
		),
	);
