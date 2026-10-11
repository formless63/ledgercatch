export type StorageErrorCode =
	| "cancelled"
	| "configuration"
	| "not_found"
	| "access_denied"
	| "unavailable"
	| "invalid_input"
	| "provider_error";
const messages: Record<StorageErrorCode, string> = {
	cancelled: "Storage operation was cancelled",
	configuration: "Storage configuration is incomplete or invalid",
	not_found: "Storage resource was not found",
	access_denied: "Storage access was denied",
	unavailable: "Storage is unavailable",
	invalid_input: "Storage input is invalid",
	provider_error: "Storage operation failed",
};
export class StorageError extends Error {
	constructor(
		public readonly code: StorageErrorCode,
		options?: ErrorOptions,
		public readonly configurationField?:
			| "STORAGE_BUCKET"
			| "STORAGE_REGION"
			| "STORAGE_ENDPOINT"
			| "STORAGE_ACCESS_KEY_ID + STORAGE_SECRET_ACCESS_KEY (+ STORAGE_SESSION_TOKEN)"
			| "STORAGE_FORCE_PATH_STYLE"
			| "STORAGE_KEY_PREFIX"
			| "STORAGE_PRESIGN_TTL_SECONDS",
	) {
		super(messages[code], options);
		this.name = "StorageError";
		if (configurationField) this.message += `: check ${configurationField}`;
	}
	toJSON() {
		return { code: this.code, message: this.message };
	}
}
export function storageError(error: unknown): StorageError {
	if (error instanceof StorageError) return error;
	const value = error as
		| { name?: string; code?: string; $metadata?: { httpStatusCode?: number } }
		| undefined;
	const status = value?.$metadata?.httpStatusCode;
	const code =
		status === 404
			? "not_found"
			: status === 401 || status === 403
				? "access_denied"
				: status === 408 ||
						status === 429 ||
						[
							"ECONNREFUSED",
							"ECONNRESET",
							"ETIMEDOUT",
							"EAI_AGAIN",
							"ENOTFOUND",
						].includes(value?.code ?? "") ||
						(status && status >= 500) ||
						[
							"TimeoutError",
							"NetworkingError",
							"ECONNREFUSED",
							"AbortError",
						].includes(value?.name ?? "")
					? "unavailable"
					: value?.name === "CredentialsProviderError"
						? "configuration"
						: "provider_error";
	return new StorageError(code, { cause: error });
}
export function invalid(condition: unknown): asserts condition {
	if (!condition) throw new StorageError("invalid_input");
}
