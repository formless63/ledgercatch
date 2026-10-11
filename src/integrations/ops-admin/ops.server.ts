export const opsMessages = {
	unauthenticated: "Authentication is required.",
	forbidden: "Operational access is denied.",
	configuration: "Operational configuration is invalid.",
	unavailable: "Operational inspection is unavailable.",
	limit: "Operational response exceeds its limit.",
} as const;
export type OpsCode = keyof typeof opsMessages;
export class OpsError extends Error {
	readonly retryable: boolean;
	constructor(readonly code: OpsCode) {
		super(opsMessages[code]);
		this.retryable = code === "unavailable";
	}
}
export const opsStatus = (code: OpsCode) =>
	({
		unauthenticated: 401,
		forbidden: 403,
		configuration: 503,
		unavailable: 503,
		limit: 413,
	})[code];
function hasControl(value: string) {
	return Array.from(value).some((c) => {
		const n = c.charCodeAt(0);
		return n < 32 || (n >= 127 && n <= 159);
	});
}
export function validOpaqueId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 128 &&
		!hasControl(value)
	);
}
export function operatorIds(raw = "") {
	const entries = raw
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	if (entries.some((x) => !validOpaqueId(x)))
		throw new OpsError("configuration");
	const ids = new Set(entries);
	if (ids.size > 100) throw new OpsError("configuration");
	return ids;
}
export type OpsGuard = {
	policy: "narrow" | "replace";
	allows: (userId: string) => boolean | Promise<boolean>;
};
/** The caller resolves a currently valid human session. Credential/tenant claims are never accepted here. */
export async function requireOperator(
	userId: string | null,
	raw: string,
	guard?: OpsGuard,
) {
	if (!validOpaqueId(userId)) throw new OpsError("unauthenticated");
	const listed = operatorIds(raw).has(userId);
	if (guard && !["narrow", "replace"].includes(guard.policy))
		throw new OpsError("configuration");
	const allowed =
		guard?.policy === "replace"
			? await guard.allows(userId)
			: listed && (!guard || (await guard.allows(userId)));
	if (!allowed) throw new OpsError("forbidden");
}
export type AdapterStatus =
	| "ok"
	| "degraded"
	| "unavailable"
	| "not-configured"
	| "timeout";
export type AdapterCode =
	| "inspection-failed"
	| "invalid-result"
	| "deadline"
	| "configuration-missing";
export type Inspection = {
	status: "ok" | "degraded" | "unavailable";
	counts?: Record<string, number>;
	code?: AdapterCode;
};
export type OpsAdapter = {
	id: string;
	title: string;
	countNames?: readonly string[];
	isConfigured: () => boolean;
	inspect: (context: { signal: AbortSignal }) => Promise<Inspection>;
};
export type OpsCard = {
	id: string;
	title: string;
	status: AdapterStatus;
	checkedAt: string;
	durationMs?: number;
	counts?: Record<string, number>;
	code?: AdapterCode;
};
export type OpsSummary = { checkedAt: string; adapters: OpsCard[] };
const machine = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const codes = new Set<AdapterCode>([
	"inspection-failed",
	"invalid-result",
	"deadline",
	"configuration-missing",
]);
function sanitized(value: Inspection, adapter: OpsAdapter): Inspection {
	if (
		!value ||
		!["ok", "degraded", "unavailable"].includes(value.status) ||
		(value.code !== undefined && !codes.has(value.code))
	)
		throw new Error();
	const result: Inspection = { status: value.status };
	if (value.code !== undefined) result.code = value.code;
	if (value.counts !== undefined) {
		const entries = Object.entries(value.counts);
		if (
			entries.length > 8 ||
			entries.some(
				([key, n]) =>
					!adapter.countNames?.includes(key) ||
					!Number.isSafeInteger(n) ||
					n < 0,
			)
		)
			throw new Error();
		result.counts = Object.fromEntries(entries);
	}
	return result;
}
/** No I/O at construction. One outstanding inspection per registered adapter, shared across refreshes.
 * Abort is propagated; an adapter with unsupported cancellation retains its slot until settlement.
 */
export function createOpsInspector(registry: readonly OpsAdapter[]) {
	if (
		registry.length > 16 ||
		new Set(registry.map((x) => x.id)).size !== registry.length ||
		registry.some(
			(x) =>
				!machine.test(x.id) ||
				x.id.length > 64 ||
				typeof x.title !== "string" ||
				x.title.length < 1 ||
				x.title.length > 80 ||
				hasControl(x.title) ||
				/[<>]/u.test(x.title) ||
				typeof x.isConfigured !== "function" ||
				typeof x.inspect !== "function" ||
				(x.countNames &&
					(x.countNames.length > 8 ||
						new Set(x.countNames).size !== x.countNames.length ||
						x.countNames.some((n) => !machine.test(n) || n.length > 64))),
		)
	)
		throw new OpsError("configuration");
	const adapters = registry.map((a) => ({
		...a,
		countNames: a.countNames ? [...a.countNames] : undefined,
	}));
	type Work = { promise: Promise<Inspection>; controller: AbortController };
	const pending = new Map<string, Work>();
	let active = 0;
	const waiters = new Set<() => void>();
	async function work(
		adapter: OpsAdapter,
		signal: AbortSignal,
	): Promise<Inspection> {
		const existing = pending.get(adapter.id);
		if (existing) return existing.promise;
		while (active >= 3) {
			await new Promise<void>((resolve) => {
				const wake = () => {
					waiters.delete(wake);
					signal.removeEventListener("abort", wake);
					resolve();
				};
				waiters.add(wake);
				signal.addEventListener("abort", wake, { once: true });
				if (signal.aborted) wake();
			});
			if (signal.aborted) throw new Error();
			const found = pending.get(adapter.id);
			if (found) return found.promise;
		}
		if (signal.aborted) throw new Error();
		active++;
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener("abort", abort, { once: true });
		const promise = Promise.resolve()
			.then(() => adapter.inspect({ signal: controller.signal }))
			.then((value) => sanitized(value, adapter))
			.finally(() => {
				pending.delete(adapter.id);
				active--;
				signal.removeEventListener("abort", abort);
				for (const wake of [...waiters]) wake();
			});
		// Install rejection handling even when all callers have reached their deadlines.
		void promise.catch(() => {});
		pending.set(adapter.id, { promise, controller });
		return promise;
	}
	return async function summary(): Promise<OpsSummary> {
		const checkedAt = new Date().toISOString();
		const total = new AbortController();
		const totalTimer = setTimeout(() => total.abort(), 5000);
		try {
			const cards = await Promise.all(
				adapters.map(async (adapter) => {
					const start = performance.now();
					const base = { id: adapter.id, title: adapter.title, checkedAt };
					try {
						if (!adapter.isConfigured())
							return {
								...base,
								status: "not-configured" as const,
								code: "configuration-missing" as const,
							};
					} catch {
						return {
							...base,
							status: "unavailable" as const,
							code: "inspection-failed" as const,
						};
					}
					const controller = new AbortController();
					const abort = () => controller.abort();
					total.signal.addEventListener("abort", abort, { once: true });
					if (total.signal.aborted) controller.abort();
					const timer = setTimeout(abort, 3000);
					let onAbort: (() => void) | undefined;
					try {
						const timeout = new Promise<never>((_, reject) => {
							onAbort = () => reject(new Error());
							controller.signal.addEventListener("abort", onAbort, {
								once: true,
							});
							if (controller.signal.aborted) onAbort();
						});
						const result = await Promise.race([
							work(adapter, controller.signal),
							timeout,
						]);
						return {
							...base,
							...result,
							durationMs: Math.round(performance.now() - start),
						};
					} catch {
						return {
							...base,
							status: controller.signal.aborted
								? ("timeout" as const)
								: ("unavailable" as const),
							code: controller.signal.aborted
								? ("deadline" as const)
								: ("inspection-failed" as const),
							durationMs: Math.round(performance.now() - start),
						};
					} finally {
						clearTimeout(timer);
						total.signal.removeEventListener("abort", abort);
						if (onAbort)
							controller.signal.removeEventListener("abort", onAbort);
					}
				}),
			);
			const result = { checkedAt, adapters: cards };
			if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536)
				throw new OpsError("limit");
			return result;
		} finally {
			clearTimeout(totalTimer);
		}
	};
}
export const opsHeaders = {
	"Cache-Control": "private, no-store",
	Vary: "Cookie",
};
export function safeOpsError(error: unknown) {
	const safe = error instanceof OpsError ? error : new OpsError("unavailable");
	return {
		status: opsStatus(safe.code),
		error: {
			code: safe.code,
			message: safe.message,
			retryable: safe.retryable,
		},
	};
}
