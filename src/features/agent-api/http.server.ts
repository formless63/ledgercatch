/**
 * Agent API plumbing: API-key auth (X-API-Key or Authorization: Bearer),
 * ledger error mapping, bounded body reading and query/path validation.
 */
import type { z } from "zod";
import type { ApiPermissionRequirement } from "#/integrations/api-platform/permissions";
import {
	type ApiPrincipal,
	requireApiKey,
} from "#/integrations/api-platform/principal.server";
import {
	ApiHttpError,
	apiErrorResponse,
	parseJsonBody,
} from "#/integrations/api-platform/responses";

/** Reads `X-API-Key` or `Authorization: Bearer <key>`. */
export function extractApiKey(request: Request): string | null {
	const header = request.headers.get("x-api-key")?.trim();
	if (header) return header;
	const authorization = request.headers.get("authorization")?.trim() ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(authorization);
	return match?.[1]?.trim() || null;
}

/** Same semantics as requireApiKey, but also accepts a Bearer token. */
export async function authenticate(
	request: Request,
	required: ApiPermissionRequirement,
): Promise<ApiPrincipal> {
	const key = extractApiKey(request);
	if (!key)
		throw new ApiHttpError(
			401,
			"unauthorized",
			"An API key is required (X-API-Key header or Authorization: Bearer <key>).",
		);
	return requireApiKey(
		new Request("http://internal.invalid/", { headers: { "x-api-key": key } }),
		required,
	);
}

const CLIENT_ERROR =
	/^(Unknown (entity|category|payment method)|Nothing to claim|Nothing selected|Some orders have no paying entity|Invalid settings|Invalid credentials|Invalid )/;

/** Translate ledger-layer errors (plain Error messages) into API errors. */
export function toApiError(error: unknown): unknown {
	if (error instanceof ApiHttpError) return error;
	if (!(error instanceof Error)) return error;
	if (error.message === "NOT_FOUND" || /not found$/i.test(error.message))
		return new ApiHttpError(404, "not_found", "Resource not found.");
	if (CLIENT_ERROR.test(error.message))
		return new ApiHttpError(422, "validation_error", error.message);
	const code =
		(error as { code?: string }).code ??
		(error.cause as { code?: string } | undefined)?.code;
	if (code === "23505")
		return new ApiHttpError(
			422,
			"validation_error",
			"The change conflicts with an existing record.",
		);
	if (code === "23503")
		return new ApiHttpError(
			422,
			"validation_error",
			"The record is still referenced by other data.",
		);
	return error;
}

export function errorResponse(error: unknown) {
	return apiErrorResponse(toApiError(error));
}

function validationError(error: z.ZodError, message: string) {
	return new ApiHttpError(
		422,
		"validation_error",
		message,
		error.issues.slice(0, 30).map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
		})),
	);
}

export function validateInput<T extends z.ZodType>(
	schema: T,
	value: unknown,
	message = "Request validation failed.",
): z.output<T> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw validationError(parsed.error, message);
	return parsed.data;
}

export function parseQuery<T extends z.ZodType>(
	request: Request,
	schema: T,
): z.output<T> {
	const params = new URL(request.url).searchParams;
	const raw: Record<string, string> = {};
	for (const [key, value] of params) if (value !== "") raw[key] = value;
	return validateInput(schema, raw, "Query validation failed.");
}

/** Malformed ids are reported as 404 (they cannot exist). */
export function parseParams<T extends z.ZodType>(
	schema: T,
	params: unknown,
): z.output<T> {
	const parsed = schema.safeParse(params);
	if (!parsed.success)
		throw new ApiHttpError(404, "not_found", "Resource not found.");
	return parsed.data;
}

export function readBody<T extends z.ZodType>(
	request: Request,
	schema: T,
	maxBytes = 65_536,
): Promise<z.output<T>> {
	return parseJsonBody(request, schema as z.ZodType<z.output<T>>, {
		maxBytes,
	});
}

/** Bounded raw read (for MCP bodies that may carry base64 documents). */
export async function readBoundedText(request: Request, maxBytes: number) {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > maxBytes)
		throw new ApiHttpError(
			413,
			"payload_too_large",
			"Request body is too large.",
		);
	const reader = request.body?.getReader();
	if (!reader) return "";
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
	return new TextDecoder().decode(Buffer.concat(chunks, size));
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export function idempotencyKey(request: Request): string | null {
	const value = request.headers.get("idempotency-key")?.trim();
	if (!value) return null;
	if (!IDEMPOTENCY_KEY.test(value))
		throw new ApiHttpError(
			400,
			"bad_request",
			"Idempotency-Key must be 1–200 printable ASCII characters.",
		);
	return value;
}

/**
 * Wrap a REST handler: authenticate with the required grants, run, and map
 * errors to the shared JSON envelope.
 */
export async function handle(
	request: Request,
	required: ApiPermissionRequirement,
	run: (principal: ApiPrincipal) => Promise<unknown>,
	status = 200,
): Promise<Response> {
	try {
		const principal = await authenticate(request, required);
		const result = await run(principal);
		if (result instanceof Response) return result;
		return Response.json(result, { status });
	} catch (error) {
		return errorResponse(error);
	}
}
