/** Idempotency keys for import captures. */
import { createHash } from "node:crypto";
import type { ParsedOrder } from "#/features/parsing/types";

/** JSON with sorted keys and `undefined` dropped (stable across runs). */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object")
		return JSON.stringify(value) ?? "null";
	if (Array.isArray(value))
		return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * sourceRef for an imported order: a hash of source + order id + content.
 * Re-importing the same file (or the same order from an overlapping export)
 * yields the same key, so createServerCapture returns the existing capture;
 * changed content (new status, tracking…) makes a new capture that merges
 * into the same order.
 */
export function importSourceRef(
	source: string,
	pageUrl: string,
	order: ParsedOrder,
): string {
	const digest = createHash("sha256")
		.update(`${source}\n${pageUrl}\n${order.externalOrderId}\n`)
		.update(stableStringify(order))
		.digest("hex");
	return `import:${digest.slice(0, 48)}`;
}
