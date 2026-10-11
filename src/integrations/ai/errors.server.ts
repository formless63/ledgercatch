export const aiErrorCodes = [
	"configuration",
	"authentication",
	"rate-limit",
	"timeout",
	"unavailable",
	"invalid-request",
	"invalid-output",
	"cancelled",
	"unknown",
] as const;
export type AiErrorCode = (typeof aiErrorCodes)[number];
// Deliberately discard provider causes: even util.inspect(Error) must remain safe.
export class AiError extends Error {
	readonly retryable: boolean;
	constructor(readonly code: AiErrorCode) {
		super(`AI operation failed: ${code}`);
		this.name = "AiError";
		this.retryable = code === "rate-limit" || code === "unavailable";
	}
	toJSON() {
		return {
			code: this.code,
			retryable: this.retryable,
			message: this.message,
		};
	}
}
export function aiError(error: unknown): AiError {
	if (error instanceof AiError) return error;
	const value = error as { status?: number; name?: string } | undefined;
	if (value?.status === 401 || value?.status === 403)
		return new AiError("authentication");
	if (value?.status === 429) return new AiError("rate-limit");
	if (value?.status === 408 || value?.name === "APIConnectionTimeoutError")
		return new AiError("timeout");
	if (value?.status && value.status >= 500) return new AiError("unavailable");
	if (value?.status && value.status >= 400)
		return new AiError("invalid-request");
	if (value?.name === "APIConnectionError") return new AiError("unavailable");
	if (error instanceof SyntaxError) return new AiError("invalid-output");
	return new AiError("unknown");
}
