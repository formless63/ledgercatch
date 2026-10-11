import { z } from "zod";

export const apiErrorCodeSchema = z.enum([
	"bad_request",
	"payload_too_large",
	"request_timeout",
	"unauthorized",
	"forbidden",
	"not_found",
	"validation_error",
	"rate_limited",
	"internal_error",
]);

export const apiErrorSchema = z.object({
	error: z.object({
		code: apiErrorCodeSchema,
		message: z.string(),
		details: z
			.array(z.object({ path: z.string(), message: z.string() }))
			.optional(),
	}),
});

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export class ApiHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: ApiErrorCode,
		message: string,
		readonly details?: Array<{ path: string; message: string }>,
	) {
		super(message);
	}
}

export function apiErrorResponse(error: unknown) {
	if (error instanceof ApiHttpError) {
		return Response.json(
			apiErrorSchema.parse({
				error: {
					code: error.code,
					message: error.message,
					details: error.details,
				},
			}),
			{ status: error.status },
		);
	}

	// Unexpected driver/auth messages can contain credentials or request input.
	console.error(JSON.stringify({ event: "api.unexpected_error" }));
	return Response.json(
		apiErrorSchema.parse({
			error: {
				code: "internal_error",
				message: "The request could not be completed.",
			},
		}),
		{ status: 500 },
	);
}

export const apiBodyDefaults = { maxBytes: 65_536, timeoutMs: 10_000 } as const;
export async function parseJsonBody<T>(
	request: Request,
	schema: z.ZodType<T>,
	options: { maxBytes?: number; timeoutMs?: number } = {},
) {
	const maxBytes = options.maxBytes ?? apiBodyDefaults.maxBytes;
	const timeoutMs = options.timeoutMs ?? apiBodyDefaults.timeoutMs;
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 1_048_576 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 10 ||
		timeoutMs > 30_000
	)
		throw new Error("Invalid API body policy");
	const tooLarge = () =>
		new ApiHttpError(
			413,
			"payload_too_large",
			"Request body exceeds the allowed size.",
		);
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > maxBytes)
	)
		throw tooLarge();
	const reader = request.body?.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new ApiHttpError(
							408,
							"request_timeout",
							"Request body was not received in time.",
						),
					),
				timeoutMs,
			);
		});
		if (reader)
			while (true) {
				const part = await Promise.race([reader.read(), deadline]);
				if (part.done) break;
				size += part.value.byteLength;
				if (size > maxBytes) throw tooLarge();
				chunks.push(part.value);
			}
		let body: unknown;
		try {
			body = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					Buffer.concat(chunks, size),
				),
			);
		} catch {
			throw new ApiHttpError(
				400,
				"bad_request",
				"Request body must be valid JSON.",
			);
		}
		const result = schema.safeParse(body);
		if (!result.success)
			throw new ApiHttpError(
				422,
				"validation_error",
				"Request validation failed.",
				result.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			);
		return result.data;
	} finally {
		clearTimeout(timer);
		void reader?.cancel().catch(() => {});
	}
}
