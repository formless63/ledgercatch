import assert from "node:assert/strict";
import {
	storageConfig,
	presignTtl,
} from "../src/integrations/storage/config.server";
import {
	StorageError,
	storageError,
} from "../src/integrations/storage/errors.server";
import {
	createStorageKey,
	normalizeStoragePrefix,
	validateStorageKey,
} from "../src/integrations/storage/keys.server";
import {
	createStorage,
	validateMetadata,
	validateParts,
} from "../src/integrations/storage/storage.server";

const baseline = { STORAGE_BUCKET: "test-bucket", AWS_REGION: "us-east-1" };
const aws = storageConfig(baseline);
assert.equal(aws.client.endpoint, undefined);
assert.equal(aws.client.credentials, undefined);
assert.equal(aws.client.forcePathStyle, false);
assert.equal(aws.ttl, 600);
assert.throws(
	() => storageConfig({ STORAGE_BUCKET: "test-bucket" }),
	(error: unknown) =>
		error instanceof StorageError && error.message.includes("STORAGE_REGION"),
);
assert.equal(
	storageConfig({
		...baseline,
		STORAGE_REGION: "garage",
		AWS_DEFAULT_REGION: "eu-west-1",
	}).client.region,
	"garage",
);
assert.equal(
	storageConfig({ ...baseline, AWS_DEFAULT_REGION: "eu-west-1" }).client.region,
	"us-east-1",
);
assert.equal(
	storageConfig({
		STORAGE_BUCKET: "test-bucket",
		AWS_DEFAULT_REGION: "eu-west-1",
	}).client.region,
	"eu-west-1",
);
assert.equal(
	storageConfig({ ...baseline, STORAGE_ENDPOINT: "http://localhost:9000" })
		.client.forcePathStyle,
	true,
);
assert.equal(
	storageConfig({
		...baseline,
		STORAGE_ENDPOINT: "http://localhost:9000",
		STORAGE_FORCE_PATH_STYLE: "false",
	}).client.forcePathStyle,
	false,
);
const explicit = storageConfig({
	...baseline,
	STORAGE_ACCESS_KEY_ID: "test",
	STORAGE_SECRET_ACCESS_KEY: "secret",
	STORAGE_SESSION_TOKEN: "session",
});
assert.deepEqual(explicit.client.credentials, {
	accessKeyId: "test",
	secretAccessKey: "secret",
	sessionToken: "session",
});
for (const overrides of [
	{ STORAGE_BUCKET: "" },
	{ STORAGE_ACCESS_KEY_ID: "test" },
	{ STORAGE_SECRET_ACCESS_KEY: "secret" },
	{ STORAGE_SESSION_TOKEN: "token" },
	{ STORAGE_ENDPOINT: "http://secret:secret@localhost" },
	{ STORAGE_ENDPOINT: "http://localhost?token=secret" },
	{ STORAGE_FORCE_PATH_STYLE: "1" },
	{ STORAGE_PRESIGN_TTL_SECONDS: "29" },
])
	assert.throws(
		() => storageConfig({ ...baseline, ...overrides }),
		StorageError,
	);
assert.throws(() => storageConfig({}), StorageError);
assert.throws(
	() => storageConfig({ ...baseline, STORAGE_ACCESS_KEY_ID: "test" }),
	(error: unknown) =>
		error instanceof StorageError &&
		error.message.includes("STORAGE_SECRET_ACCESS_KEY") &&
		!error.message.includes("test"),
);
for (const ttl of [29, 3601, 10.5, NaN])
	assert.throws(() => presignTtl(ttl), StorageError);
assert.equal(presignTtl(30), 30);
assert.equal(presignTtl(3600), 3600);
assert.equal(normalizeStoragePrefix("/my-app/"), "my-app/");
const keys = new Set(
	Array.from({ length: 100 }, () => createStorageKey("uploads", "/my-app/")),
);
assert.equal(keys.size, 100);
for (const key of keys) assert.match(key, /^my-app\/uploads\/[a-f0-9-]+$/);
for (const key of [
	"",
	"/leading",
	"double//slash",
	"dot/./key",
	"traverse/../key",
	"control\nkey",
	"raw user filename.pdf",
	"name\\file",
	"a".repeat(1025),
])
	assert.throws(() => validateStorageKey(key), StorageError);
assert.throws(() => createStorageKey("../../userfile.pdf"), StorageError);
assert.throws(
	() => validateMetadata({ contentType: "text/plain\nX-secret: x" }),
	StorageError,
);
assert.throws(
	() => validateMetadata({ metadata: { unsafe: "a".repeat(257) } }),
	StorageError,
);
assert.throws(
	() => validateMetadata({ metadata: { "Upper-case": "no" } }),
	StorageError,
);
for (const parts of [
	[],
	[{ partNumber: 0, etag: "abc" }],
	[{ partNumber: 10001, etag: "abc" }],
	[{ partNumber: 1, etag: "" }],
	[
		{ partNumber: 1, etag: "abc" },
		{ partNumber: 1, etag: "def" },
	],
	[
		{ partNumber: 2, etag: "abc" },
		{ partNumber: 1, etag: "def" },
	],
])
	assert.throws(() => validateParts(parts), StorageError);
assert.equal(
	validateParts([{ partNumber: 1, etag: '"abcdef"' }])[0]?.PartNumber,
	1,
);
assert.throws(
	() => validateParts([{ partNumber: 1, etag: '"unbalanced' }]),
	StorageError,
);
assert.throws(() => validateParts(Array(1)), StorageError);
for (const [status, code] of [
	[404, "not_found"],
	[403, "access_denied"],
	[503, "unavailable"],
	[400, "provider_error"],
] as const) {
	const cause = {
		$metadata: { httpStatusCode: status },
		message: "https://credentials.example/?secret=token",
	};
	const error = storageError(cause);
	assert.equal(error.code, code);
	assert.equal(error.cause, cause);
	assert.ok(!JSON.stringify(error).includes("secret"));
}
const client = createStorage(aws);
assert.equal(
	storageError({ name: "Error", code: "ECONNREFUSED" }).code,
	"unavailable",
);
assert.equal(typeof client.getS3Client().config.credentials, "function");
client.close();
const signed = createStorage(explicit);
await assert.rejects(signed.presignUpload("safe", { ttl: 1 }), StorageError);
await assert.rejects(signed.presignMultipartPart("safe", "", 1), StorageError);
await assert.rejects(
	signed.presignMultipartPart("safe", "upload", 0),
	StorageError,
);
const url = await signed.presignUpload("safe", { contentType: "text/plain" });
assert.ok(
	new URL(url.url).searchParams
		.get("X-Amz-SignedHeaders")
		?.includes("content-type"),
);
assert.equal(url.headers["Content-Type"], "text/plain");
signed.close();
console.info(
	"Storage configuration, key, metadata, multipart, and safe-error unit checks passed",
);
