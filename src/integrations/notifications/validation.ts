export type NotificationJson =
	| null
	| boolean
	| number
	| string
	| NotificationJson[]
	| { [key: string]: NotificationJson };
export class NotificationError extends Error {
	constructor(
		readonly code:
			| "invalid-input"
			| "unavailable"
			| "configuration"
			| "not-found",
		readonly retryable = false,
	) {
		super(`Notifications ${code}`);
		this.name = "NotificationError";
	}
}
const fail = (): never => {
	throw new NotificationError("invalid-input");
};
const controls = /\p{Cc}/u;
const invalidUnicode =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
export function boundedString(value: unknown, max: number): string {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > max ||
		value.trim() !== value ||
		controls.test(value) ||
		invalidUnicode.test(value)
	)
		fail();
	return value as string;
}
export const METADATA_LIMITS = {
	bytes: 8192,
	depth: 6,
	keys: 50,
	arrayLength: 100,
	nodes: 1024,
} as const;
// Reject, never redact: callers must deliberately select safe context.
const sensitive =
	/password|passwd|pwd|secret|token|authorization|cookie|apikey|credential/;
export function validateNotificationMetadata(input: unknown = {}): {
	[key: string]: NotificationJson;
} {
	let nodes = 0;
	const seen = new Set<object>();
	function visit(value: unknown, depth: number): NotificationJson {
		if (++nodes > METADATA_LIMITS.nodes || depth > METADATA_LIMITS.depth)
			fail();
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			if (!Number.isFinite(value)) fail();
			return value;
		}
		if (typeof value === "string") {
			if (
				controls.test(value) ||
				invalidUnicode.test(value) ||
				value.length > 1024
			)
				fail();
			return value;
		}
		if (typeof value !== "object" || value === null || seen.has(value)) fail();
		const object = value as object;
		const array = Array.isArray(object);
		if (array && Object.getPrototypeOf(object) !== Array.prototype) fail();
		if (
			!array &&
			Object.getPrototypeOf(object) !== Object.prototype &&
			Object.getPrototypeOf(object) !== null
		)
			fail();
		seen.add(object);
		const descriptors = Object.getOwnPropertyDescriptors(object);
		if (Object.getOwnPropertySymbols(object).length) fail();
		if (array) {
			const items = object as unknown[];
			if (
				items.length > METADATA_LIMITS.arrayLength ||
				Object.keys(descriptors).length !== items.length + 1
			)
				fail();
			const result: NotificationJson[] = [];
			for (let i = 0; i < items.length; i++) {
				const descriptor = descriptors[String(i)];
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
					fail();
				result.push(visit(descriptor.value, depth + 1));
			}
			seen.delete(object);
			return result;
		}
		const entries = Object.entries(descriptors);
		if (entries.length > METADATA_LIMITS.keys) fail();
		const result: { [key: string]: NotificationJson } = {};
		for (const [key, descriptor] of entries) {
			if (
				!key.length ||
				key.length > 64 ||
				controls.test(key) ||
				invalidUnicode.test(key)
			)
				fail();
			if (
				sensitive.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")) ||
				["request", "session", "body", "header", "headers"].includes(
					key.toLowerCase().replace(/[^a-z0-9]/g, ""),
				) ||
				["__proto__", "prototype", "constructor"].includes(key) ||
				!("value" in descriptor) ||
				!descriptor.enumerable
			)
				fail();
			result[key] = visit(descriptor.value, depth + 1);
		}
		seen.delete(object);
		return result;
	}
	if (input === null || typeof input !== "object" || Array.isArray(input))
		fail();
	const result = visit(input, 0) as { [key: string]: NotificationJson };
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > METADATA_LIMITS.bytes)
		fail();
	return result;
}
