export type EmailErrorCode =
	| "configuration"
	| "connection"
	| "timeout"
	| "tls"
	| "authentication"
	| "temporary-rejection"
	| "permanent-rejection"
	| "message"
	| "unknown";
export class EmailError extends Error {
	constructor(
		public readonly code: EmailErrorCode,
		public readonly retryable = false,
		cause?: unknown,
	) {
		super(
			`Email operation failed: ${code}`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "EmailError";
	}
	toJSON() {
		return {
			code: this.code,
			retryable: this.retryable,
			message: this.message,
		};
	}
}
export function emailError(error: unknown): EmailError {
	if (error instanceof EmailError) return error;
	const value = error as { code?: string; responseCode?: number } | undefined;
	const code = typeof value?.code === "string" ? value.code : "";
	if (
		code === "ETLS" ||
		code.startsWith("ERR_TLS") ||
		[
			"DEPTH_ZERO_SELF_SIGNED_CERT",
			"CERT_HAS_EXPIRED",
			"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
			"SELF_SIGNED_CERT_IN_CHAIN",
		].includes(code)
	)
		return new EmailError("tls", false, error);
	if (code === "EAUTH") return new EmailError("authentication", false, error);
	if (
		value?.responseCode &&
		value.responseCode >= 400 &&
		value.responseCode < 500
	)
		return new EmailError("temporary-rejection", true, error);
	if (
		value?.responseCode &&
		value.responseCode >= 500 &&
		value.responseCode < 600
	)
		return new EmailError("permanent-rejection", false, error);
	if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT")
		return new EmailError("timeout", false, error);
	if (
		[
			"ECONNREFUSED",
			"ECONNRESET",
			"ECONNECTION",
			"ESOCKET",
			"ENOTFOUND",
			"EAI_AGAIN",
		].includes(code)
	)
		return new EmailError(
			"connection",
			code === "ECONNREFUSED" || code === "EAI_AGAIN",
			error,
		);
	if (["EMESSAGE", "EENVELOPE", "ESTREAM"].includes(code))
		return new EmailError("message", false, error);
	return new EmailError("unknown", false, error);
}
