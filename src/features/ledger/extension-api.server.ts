/**
 * Machine API used by the browser extension (X-API-Key, API Platform keys).
 * Contract: src/shared/capture.ts.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { user } from "#/db/schema";
import { env } from "#/env";
import { requireApiKey } from "#/integrations/api-platform/principal.server";
import {
	ApiHttpError,
	apiErrorResponse,
} from "#/integrations/api-platform/responses";
import { readMultipart } from "#/lib/multipart.server";
import {
	captureEnvelopeSchema,
	documentUploadMetaSchema,
	extensionStatusSchema,
	MAX_DOCUMENT_BYTES,
	orderLookupRequestSchema,
	orderLookupResponseSchema,
} from "#/shared/capture";
import { ingestCapture } from "./captures.server";
import { storeUploadedDocument } from "./documents.server";
import { documents, orders } from "./schema";

const MAX_CAPTURE_BODY = 12 * 1024 * 1024;

async function readBounded(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array> {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > maxBytes)
		throw new ApiHttpError(
			413,
			"payload_too_large",
			"Request body is too large.",
		);
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new ApiHttpError(
				413,
				"payload_too_large",
				"Request body is too large.",
			);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new ApiHttpError(
			422,
			"validation_error",
			"Request body is invalid.",
			parsed.error.issues.slice(0, 20).map((issue) => ({
				path: issue.path.join("."),
				message: issue.message,
			})),
		);
	return parsed.data;
}

async function readJson<T>(
	request: Request,
	schema: z.ZodType<T>,
	maxBytes: number,
) {
	const bytes = await readBounded(request, maxBytes);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ApiHttpError(400, "bad_request", "Request body must be JSON.");
	}
	return validate(schema, value);
}

export function dashboardOrderUrl(orderId: string) {
	return `${env.APP_BASE_URL.replace(/\/$/, "")}/app/orders/${orderId}`;
}

export async function extensionStatusApi(request: Request) {
	try {
		const principal = await requireApiKey(request, {});
		const [owner] = await db
			.select({ name: user.name, email: user.email })
			.from(user)
			.where(eq(user.id, principal.userId));
		return Response.json(
			extensionStatusSchema.parse({
				appName: env.APP_NAME,
				user: { name: owner?.name ?? "", email: owner?.email ?? "" },
				serverTime: new Date().toISOString(),
			}),
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}

export async function createCaptureApi(request: Request) {
	try {
		const principal = await requireApiKey(request, { captures: ["write"] });
		const envelope = await readJson(
			request,
			captureEnvelopeSchema,
			MAX_CAPTURE_BODY,
		);
		const result = await ingestCapture(principal.userId, envelope);
		return Response.json(result, {
			status: result.status === "accepted" ? 201 : 200,
		});
	} catch (error) {
		return apiErrorResponse(error);
	}
}

export async function uploadDocumentApi(request: Request) {
	try {
		const principal = await requireApiKey(request, { captures: ["write"] });
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
		const rawMeta = form.get("meta");
		const file = form.get("file");
		if (typeof rawMeta !== "string" || !(file instanceof Blob))
			throw new ApiHttpError(
				400,
				"bad_request",
				"Fields `meta` and `file` are required.",
			);
		let metaJson: unknown;
		try {
			metaJson = JSON.parse(rawMeta);
		} catch {
			throw new ApiHttpError(400, "bad_request", "`meta` must be JSON.");
		}
		const meta = validate(documentUploadMetaSchema, metaJson);
		if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES)
			throw new ApiHttpError(
				413,
				"payload_too_large",
				"Document is empty or too large.",
			);
		const bytes = new Uint8Array(await file.arrayBuffer());
		const stored = await storeUploadedDocument(
			principal.userId,
			meta,
			bytes,
			file.type || "application/octet-stream",
		);
		return Response.json(
			{
				documentId: stored.id,
				duplicate: stored.duplicate,
				orderId: stored.orderId,
			},
			{ status: stored.duplicate ? 200 : 201 },
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}

export async function lookupOrdersApi(request: Request) {
	try {
		const principal = await requireApiKey(request, { orders: ["read"] });
		const body = await readJson(request, orderLookupRequestSchema, 64 * 1024);
		const ids = [...new Set(body.externalOrderIds)];
		const rows = ids.length
			? await db
					.select({ id: orders.id, externalOrderId: orders.externalOrderId })
					.from(orders)
					.where(
						and(
							eq(orders.ownerId, principal.userId),
							eq(orders.source, body.source),
							inArray(orders.externalOrderId, ids),
						),
					)
			: [];
		const withInvoice = rows.length
			? new Set(
					(
						await db
							.select({ orderId: documents.orderId })
							.from(documents)
							.where(
								and(
									inArray(
										documents.orderId,
										rows.map((row) => row.id),
									),
									inArray(documents.kind, ["invoice", "receipt"]),
								),
							)
					).map((row) => row.orderId),
				)
			: new Set<string | null>();
		return Response.json(
			orderLookupResponseSchema.parse({
				orders: rows.map((row) => ({
					externalOrderId: row.externalOrderId,
					orderId: row.id,
					hasInvoice: withInvoice.has(row.id),
					dashboardUrl: dashboardOrderUrl(row.id),
				})),
			}),
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}
