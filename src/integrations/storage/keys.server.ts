import { randomUUID } from "node:crypto";
import { invalid } from "./errors.server";

// Intentionally conservative application keys, not the entire S3 key alphabet.
export function validateStorageKey(key: string): string {
	invalid(
		typeof key === "string" && key.length > 0 && Buffer.byteLength(key) <= 1024,
	);
	invalid(
		key
			.split("/")
			.every(
				(segment) =>
					/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(segment) &&
					segment !== "." &&
					segment !== "..",
			),
	);
	return key;
}
export function normalizeStoragePrefix(prefix = ""): string {
	if (!prefix) return "";
	const normalized = prefix.replace(/^\/+|\/+$/g, "");
	return `${validateStorageKey(normalized)}/`;
}
export function createStorageKey(namespace: string, prefix = ""): string {
	return validateStorageKey(
		`${normalizeStoragePrefix(prefix)}${validateStorageKey(namespace)}/${randomUUID()}`,
	);
}
