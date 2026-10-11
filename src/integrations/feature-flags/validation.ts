export const messages = {
	configuration: "FeatureFlags configuration is invalid.",
	"invalid-input": "FeatureFlags input is invalid.",
	unauthenticated: "Authentication is required.",
	forbidden: "Permission is required.",
	"not-found": "FeatureFlags resource was not found.",
	conflict: "FeatureFlags state conflicts with this operation.",
	timeout: "FeatureFlags operation timed out.",
	unavailable: "FeatureFlags service is unavailable.",
	unknown: "FeatureFlags operation failed.",
} as const;
export type FeatureFlagsCode = keyof typeof messages;
export class FeatureFlagsError extends Error {
	readonly retryable: boolean;
	constructor(readonly code: FeatureFlagsCode) {
		super(messages[code]);
		this.name = "FeatureFlagsError";
		this.retryable = code === "unavailable" || code === "timeout";
	}
	toJSON() {
		return {
			code: this.code,
			message: this.message,
			retryable: this.retryable,
		};
	}
}
export type Scope = Readonly<{ kind: "user" | "tenant"; id: string }>;
export function opaqueId(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.length ||
		value.length > 128 ||
		Array.from(value).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		)
	)
		throw new FeatureFlagsError("invalid-input");
	return value;
}
export function actionId(value: unknown, max = 128, requireDot = true): string {
	if (
		typeof value !== "string" ||
		value.length > max ||
		value.trim() !== value ||
		!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value) ||
		(requireDot && !value.includes("."))
	)
		throw new FeatureFlagsError("invalid-input");
	return value;
}
export function exactScope(scope: Scope): Scope {
	if (!scope || !(scope.kind === "user" || scope.kind === "tenant"))
		throw new FeatureFlagsError("invalid-input");
	return Object.freeze({ kind: scope.kind, id: opaqueId(scope.id) });
}
export function safeError(error: unknown): FeatureFlagsError {
	if (error instanceof FeatureFlagsError) return error;
	const code =
		(error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ??
		(error as { cause?: { code?: unknown } } | null)?.cause?.code;
	if (code === "57014" || code === "55P03")
		return new FeatureFlagsError("timeout");
	if (code === "23505") return new FeatureFlagsError("conflict");
	return new FeatureFlagsError("unavailable");
}
export function cursorFor(row: { id: string; createdAt: Date }) {
	return Buffer.from(
		JSON.stringify([1, row.createdAt.toISOString(), row.id]),
	).toString("base64url");
}
export function pageInput(
	input: { limit?: number; cursor?: string } = {},
	kind: "key" | "uuid" = "uuid",
) {
	const limit = input.limit ?? 25;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new FeatureFlagsError("invalid-input");
	let cursor: { id: string; createdAt: Date } | undefined;
	if (input.cursor !== undefined) {
		try {
			const raw = input.cursor;
			if (
				typeof raw !== "string" ||
				raw.length > 2048 ||
				!/^[A-Za-z0-9_-]+$/.test(raw)
			)
				throw 0;
			const tuple: unknown = JSON.parse(
				Buffer.from(raw, "base64url").toString("utf8"),
			);
			if (
				!Array.isArray(tuple) ||
				tuple.length !== 3 ||
				tuple[0] !== 1 ||
				typeof tuple[1] !== "string" ||
				typeof tuple[2] !== "string" ||
				tuple[2].length < 1 ||
				tuple[2].length > 128
			)
				throw 0;
			if (kind === "key") actionId(tuple[2], 128, false);
			else if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
					tuple[2],
				)
			)
				throw 0;
			cursor = { createdAt: new Date(tuple[1]), id: tuple[2] };
			if (
				cursor.createdAt.toISOString() !== tuple[1] ||
				cursorFor(cursor) !== raw
			)
				throw 0;
		} catch {
			throw new FeatureFlagsError("invalid-input");
		}
	}
	return { limit, cursor };
}
