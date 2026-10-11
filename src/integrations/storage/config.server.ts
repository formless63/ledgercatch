import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { StorageError } from "./errors.server";
import { normalizeStoragePrefix } from "./keys.server";

export function presignTtl(value: number): number {
	if (!Number.isInteger(value) || value < 30 || value > 3600)
		throw new StorageError("invalid_input");
	return value;
}
export function storageConfig(env: NodeJS.ProcessEnv = process.env) {
	let field: ConstructorParameters<typeof StorageError>[2] = "STORAGE_BUCKET";
	try {
		const bucket = env.STORAGE_BUCKET?.trim();
		const region =
			env.STORAGE_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION;
		if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
			throw new Error();
		field = "STORAGE_REGION";
		if (!region || !/^[a-zA-Z0-9_-]{1,64}$/.test(region)) throw new Error();
		field = "STORAGE_ENDPOINT";
		const endpoint = env.STORAGE_ENDPOINT || undefined;
		if (endpoint) {
			const url = new URL(endpoint);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.pathname !== "/"
			)
				throw new Error();
		}
		const accessKeyId = env.STORAGE_ACCESS_KEY_ID || undefined;
		const secretAccessKey = env.STORAGE_SECRET_ACCESS_KEY || undefined;
		const sessionToken = env.STORAGE_SESSION_TOKEN || undefined;
		field =
			"STORAGE_ACCESS_KEY_ID + STORAGE_SECRET_ACCESS_KEY (+ STORAGE_SESSION_TOKEN)";
		if (!!accessKeyId !== !!secretAccessKey || (sessionToken && !accessKeyId))
			throw new Error();
		const pathStyle = env.STORAGE_FORCE_PATH_STYLE || undefined;
		field = "STORAGE_FORCE_PATH_STYLE";
		if (pathStyle && !["true", "false"].includes(pathStyle)) throw new Error();
		const client: S3ClientConfig = {
			region,
			...(endpoint ? { endpoint } : {}),
			forcePathStyle: pathStyle ? pathStyle === "true" : !!endpoint,
			...(accessKeyId && secretAccessKey
				? {
						credentials: {
							accessKeyId,
							secretAccessKey,
							...(sessionToken ? { sessionToken } : {}),
						},
					}
				: {}),
			// Common portable checksum behavior, not provider-specific headers.
			requestChecksumCalculation: "WHEN_REQUIRED",
			responseChecksumValidation: "WHEN_REQUIRED",
			maxAttempts: 3,
			requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 },
		};
		field = "STORAGE_KEY_PREFIX";
		const prefix = normalizeStoragePrefix(env.STORAGE_KEY_PREFIX);
		field = "STORAGE_PRESIGN_TTL_SECONDS";
		return {
			bucket,
			client,
			prefix,
			ttl: presignTtl(Number(env.STORAGE_PRESIGN_TTL_SECONDS || 600)),
		};
	} catch (cause) {
		throw new StorageError("configuration", { cause }, field);
	}
}
