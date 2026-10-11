import type { AuditJson } from "./schema";

export class AuditLogError extends Error {
	constructor(
		readonly code: "INVALID_EVENT" | "INVALID_QUERY" | "DATABASE_ERROR",
	) {
		super(
			code === "DATABASE_ERROR"
				? "Audit log operation failed"
				: "Invalid audit log input",
		);
		this.name = "AuditLogError";
	}
}
const fail = (): never => {
	throw new AuditLogError("INVALID_EVENT");
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
export function identifier(value: unknown, max = 64): string {
	const result = boundedString(value, max);
	if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(result)) fail();
	return result;
}
export function actionIdentifier(value: unknown): string {
	const result = identifier(value, 128);
	if (!result.includes(".")) fail();
	return result;
}
export function optionalId(value: unknown, max = 128): string | null {
	return value === undefined || value === null
		? null
		: boundedString(value, max);
}
export interface AuditIdentity {
	type: string;
	id?: string | null;
}
export function createAuditActor(
	type: string,
	id?: string | null,
): AuditIdentity {
	return { type: identifier(type, 32), id: optionalId(id) };
}
export function createAuditSubject(
	type: string,
	id?: string | null,
): AuditIdentity {
	return { type: identifier(type, 64), id: optionalId(id) };
}
export function auditDate(value: unknown): Date {
	if (
		!(value instanceof Date) ||
		!Number.isFinite(value.getTime()) ||
		value.getUTCFullYear() < 1 ||
		value.getUTCFullYear() > 9999
	)
		fail();
	return new Date((value as Date).getTime());
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
export function validateAuditMetadata(input: unknown = {}): {
	[key: string]: AuditJson;
} {
	let nodes = 0;
	const seen = new Set<object>();
	function visit(value: unknown, depth: number): AuditJson {
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
			const result: AuditJson[] = [];
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
		const result: { [key: string]: AuditJson } = {};
		for (const [key, descriptor] of entries) {
			boundedString(key, 64);
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
	const result = visit(input, 0) as { [key: string]: AuditJson };
	if (Buffer.byteLength(JSON.stringify(result), "utf8") > METADATA_LIMITS.bytes)
		fail();
	return result;
}
