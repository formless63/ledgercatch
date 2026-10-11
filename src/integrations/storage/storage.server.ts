import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type PutObjectCommandInput,
	S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { presignTtl, storageConfig } from "./config.server";
import { invalid, StorageError, storageError } from "./errors.server";
import { createStorageKey, validateStorageKey } from "./keys.server";

export const storageOperations = [
	"check",
	"put",
	"get",
	"head",
	"delete",
	"list",
	"presignUpload",
	"presignDownload",
	"multipartCreate",
	"multipartPresign",
	"multipartComplete",
	"multipartAbort",
] as const;
export type StorageOperation = (typeof storageOperations)[number];
export type OperationHook = <T>(
	operation: StorageOperation,
	run: () => Promise<T>,
) => Promise<T>;
export interface ObjectMetadata {
	contentType?: string;
	cacheControl?: string;
	metadata?: Record<string, string>;
}
function header(value: string | undefined) {
	invalid(
		value === undefined ||
			(typeof value === "string" &&
				value.length > 0 &&
				value.length <= 256 &&
				/^[\x20-\x7e]+$/.test(value)),
	);
	return value;
}
export function validateMetadata(options: ObjectMetadata = {}) {
	const metadata = options.metadata;
	if (metadata) {
		invalid(typeof metadata === "object" && !Array.isArray(metadata));
		invalid(Object.keys(metadata).length <= 16);
		let bytes = 0;
		for (const [key, value] of Object.entries(metadata)) {
			invalid(/^[a-z][a-z0-9-]{0,63}$/.test(key));
			header(value);
			bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
		}
		invalid(bytes <= 2048);
	}
	return {
		ContentType: header(options.contentType),
		CacheControl: header(options.cacheControl),
		Metadata: metadata,
	};
}
function uploadId(value: string) {
	invalid(
		typeof value === "string" &&
			value.length > 0 &&
			value.length <= 2048 &&
			Array.from(value).every(
				(character) =>
					character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
			),
	);
	return value;
}
function partNumber(value: number) {
	invalid(Number.isInteger(value) && value >= 1 && value <= 10000);
	return value;
}
export function validateParts(parts: { partNumber: number; etag: string }[]) {
	invalid(Array.isArray(parts) && parts.length > 0 && parts.length <= 10000);
	let previous = 0;
	return Array.from(parts).map((part) => {
		invalid(part !== null && typeof part === "object");
		const number = partNumber(part.partNumber);
		invalid(
			number > previous &&
				typeof part.etag === "string" &&
				/^(?:"[a-zA-Z0-9_-]{1,128}"|[a-zA-Z0-9_-]{1,128})$/.test(part.etag),
		);
		previous = number;
		return { PartNumber: number, ETag: part.etag };
	});
}
function metadataOf(value: {
	ContentType?: string;
	ContentLength?: number;
	ETag?: string;
	LastModified?: Date;
	CacheControl?: string;
	Metadata?: Record<string, string>;
}) {
	return {
		contentType: value.ContentType,
		contentLength: value.ContentLength,
		etag: value.ETag,
		lastModified: value.LastModified,
		cacheControl: value.CacheControl,
		metadata: value.Metadata ?? {},
	};
}
function preabort(signal?: AbortSignal) {
	if (signal?.aborted) throw new StorageError("cancelled");
}
function requestedAbort(error: unknown, signal?: AbortSignal) {
	// An unrelated provider failure remains its normal classification even if cancellation races it.
	return signal?.aborted && (error as { name?: string })?.name === "AbortError"
		? new StorageError("cancelled", { cause: error })
		: storageError(error);
}
function bindBodyAbort(body: unknown, signal: AbortSignal) {
	const stream = body as {
		destroy?: (error?: Error) => void;
		cancel?: (reason?: unknown) => Promise<void>;
		once?: (event: string, callback: () => void) => void;
	};
	const cleanup = () => signal.removeEventListener("abort", abort);
	const abort = () => {
		if (stream.destroy) stream.destroy(new StorageError("cancelled"));
		else void stream.cancel?.(new StorageError("cancelled")).catch(() => {});
		cleanup();
	};
	signal.addEventListener("abort", abort, { once: true });
	stream.once?.("end", cleanup);
	stream.once?.("close", cleanup);
	stream.once?.("error", cleanup);
	if (signal.aborted) abort();
}
export function createStorage(config = storageConfig(), hook?: OperationHook) {
	if (typeof window !== "undefined") throw new StorageError("configuration");
	const client = new S3Client(config.client);
	async function operation<T>(
		name: StorageOperation,
		work: () => Promise<T>,
	): Promise<T> {
		const safeWork = async () => {
			try {
				return await work();
			} catch (error) {
				throw storageError(error);
			}
		};
		return hook ? hook(name, safeWork) : safeWork();
	}
	function object(key: string) {
		validateStorageKey(key);
		invalid(!config.prefix || key.startsWith(config.prefix));
		return { Bucket: config.bucket, Key: key };
	}
	function ttl(value?: number) {
		return presignTtl(value ?? config.ttl);
	}
	const storage = {
		getS3Client: () => client,
		close: () => client.destroy(),
		createKey: (namespace: string) =>
			createStorageKey(namespace, config.prefix),
		checkStorage: () =>
			operation("check", async () => {
				await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
				return { status: "ok" as const };
			}),
		putObject: (
			key: string,
			body: PutObjectCommandInput["Body"],
			options: ObjectMetadata & {
				contentLength?: number;
				signal?: AbortSignal;
			} = {},
		) =>
			operation("put", async () => {
				preabort(options.signal);
				invalid(body !== undefined);
				invalid(
					options.contentLength === undefined ||
						(Number.isSafeInteger(options.contentLength) &&
							options.contentLength >= 0),
				);
				const result = await client
					.send(
						new PutObjectCommand({
							...object(key),
							Body: body,
							...validateMetadata(options),
							ContentLength: options.contentLength,
						}),
						{ abortSignal: options.signal },
					)
					.catch((error: unknown) => {
						throw requestedAbort(error, options.signal);
					});
				return { etag: result.ETag };
			}),
		getObject: (key: string, options: { signal?: AbortSignal } = {}) =>
			operation("get", async () => {
				preabort(options.signal);
				const result = await client
					.send(new GetObjectCommand(object(key)), {
						abortSignal: options.signal,
					})
					.catch((error: unknown) => {
						throw requestedAbort(error, options.signal);
					});
				if (result.Body && options.signal)
					bindBodyAbort(result.Body, options.signal);
				return { ...metadataOf(result), body: result.Body };
			}),
		headObject: (key: string, options: { signal?: AbortSignal } = {}) =>
			operation("head", async () => {
				preabort(options.signal);
				return metadataOf(
					await client
						.send(new HeadObjectCommand(object(key)), {
							abortSignal: options.signal,
						})
						.catch((error: unknown) => {
							throw requestedAbort(error, options.signal);
						}),
				);
			}),
		deleteObject: (key: string) =>
			operation("delete", async () => {
				await client.send(new DeleteObjectCommand(object(key)));
			}),
		listObjects: (options: {
			prefix: string;
			cursor?: string;
			limit?: number;
		}) =>
			operation("list", async () => {
				const prefix = options.prefix;
				validateStorageKey(prefix.replace(/\/$/, ""));
				invalid(!config.prefix || prefix.startsWith(config.prefix));
				invalid(
					options.limit === undefined ||
						(Number.isInteger(options.limit) &&
							options.limit >= 1 &&
							options.limit <= 1000),
				);
				invalid(
					options.cursor === undefined ||
						(typeof options.cursor === "string" &&
							options.cursor.length <= 8192),
				);
				const result = await client.send(
					new ListObjectsV2Command({
						Bucket: config.bucket,
						Prefix: prefix,
						ContinuationToken: options.cursor,
						MaxKeys: options.limit ?? 100,
					}),
				);
				return {
					objects: (result.Contents ?? []).map((item) => ({
						key: item.Key,
						size: item.Size,
						etag: item.ETag,
						lastModified: item.LastModified,
					})),
					cursor: result.NextContinuationToken,
				};
			}),
		presignUpload: (
			key: string,
			options: { contentType?: string; ttl?: number } = {},
		) =>
			operation("presignUpload", async () => {
				const contentType = header(options.contentType);
				const expiresIn = ttl(options.ttl);
				const url = await getSignedUrl(
					client,
					new PutObjectCommand({ ...object(key), ContentType: contentType }),
					{
						expiresIn,
						signableHeaders: new Set(contentType ? ["content-type"] : []),
					},
				);
				const headers: Record<string, string> = contentType
					? { "Content-Type": contentType }
					: {};
				return { url, method: "PUT" as const, headers, expiresIn };
			}),
		presignDownload: (key: string, options: { ttl?: number } = {}) =>
			operation("presignDownload", async () => {
				const expiresIn = ttl(options.ttl);
				return {
					url: await getSignedUrl(client, new GetObjectCommand(object(key)), {
						expiresIn,
					}),
					method: "GET" as const,
					headers: {},
					expiresIn,
				};
			}),
		createMultipartUpload: (key: string, options: ObjectMetadata = {}) =>
			operation("multipartCreate", async () => {
				const result = await client.send(
					new CreateMultipartUploadCommand({
						...object(key),
						...validateMetadata(options),
					}),
				);
				if (!result.UploadId) throw new StorageError("provider_error");
				return { uploadId: result.UploadId };
			}),
		presignMultipartPart: (
			key: string,
			id: string,
			number: number,
			options: { ttl?: number } = {},
		) =>
			operation("multipartPresign", async () => {
				const expiresIn = ttl(options.ttl);
				return {
					url: await getSignedUrl(
						client,
						new UploadPartCommand({
							...object(key),
							UploadId: uploadId(id),
							PartNumber: partNumber(number),
						}),
						{ expiresIn },
					),
					method: "PUT" as const,
					headers: {},
					expiresIn,
				};
			}),
		completeMultipartUpload: (
			key: string,
			id: string,
			parts: { partNumber: number; etag: string }[],
		) =>
			operation("multipartComplete", async () => {
				const result = await client.send(
					new CompleteMultipartUploadCommand({
						...object(key),
						UploadId: uploadId(id),
						MultipartUpload: { Parts: validateParts(parts) },
					}),
				);
				return { etag: result.ETag };
			}),
		abortMultipartUpload: (key: string, id: string) =>
			operation("multipartAbort", async () => {
				await client.send(
					new AbortMultipartUploadCommand({
						...object(key),
						UploadId: uploadId(id),
					}),
				);
			}),
		verifyUploadedObject: async (
			key: string,
			policy: {
				maxBytes: number;
				contentType?: string;
				metadata?: Record<string, string>;
			},
		) => {
			invalid(Number.isSafeInteger(policy.maxBytes) && policy.maxBytes >= 0);
			validateMetadata(policy);
			const result = await storage.headObject(key);
			invalid(
				result.contentLength !== undefined &&
					result.contentLength <= policy.maxBytes,
			);
			invalid(!policy.contentType || result.contentType === policy.contentType);
			for (const [name, value] of Object.entries(policy.metadata ?? {}))
				invalid(result.metadata[name] === value);
			return result;
		},
	};
	return storage;
}
let singleton: ReturnType<typeof createStorage> | undefined;
// Configuration/credentials/bucket access are lazy; importing never contacts storage.
export function getStorage() {
	singleton ??= createStorage();
	return singleton;
}
export function getS3Client() {
	return getStorage().getS3Client();
}
export function checkStorage() {
	return getStorage().checkStorage();
}
