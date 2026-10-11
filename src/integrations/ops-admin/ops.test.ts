import { describe, expect, it, vi } from "vitest";
import {
	createOpsInspector,
	operatorIds,
	requireOperator,
	safeOpsError,
} from "./ops.server";

describe("Ops access", () => {
	it("requires a human session and explicit operator membership", async () => {
		await expect(requireOperator(null, "operator")).rejects.toMatchObject({
			code: "unauthenticated",
		});
		await expect(
			requireOperator("org-owner", "operator"),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(requireOperator("operator", "")).rejects.toMatchObject({
			code: "forbidden",
		});
		await requireOperator("opaque-user", " opaque-user,opaque-user, ");
		await expect(
			requireOperator("operator", "operator", {
				policy: "narrow",
				allows: () => false,
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		await requireOperator("replacement", "", {
			policy: "replace",
			allows: () => true,
		});
	});
	it("deduplicates before enforcing the 100 distinct operator limit", () => {
		expect(operatorIds(Array(1001).fill(" valid-user ").join(","))).toEqual(
			new Set(["valid-user"]),
		);
		expect(() =>
			operatorIds(
				Array.from({ length: 101 }, (_, i) => `distinct-${i}`).join(","),
			),
		).toThrow();
	});
	it("fails malformed configuration closed", () => {
		expect(() => operatorIds("a\u0000")).toThrow();
		expect(() => operatorIds("a".repeat(129))).toThrow();
		expect(() =>
			operatorIds(Array.from({ length: 101 }, (_, i) => `u${i}`).join(",")),
		).toThrow();
		expect(safeOpsError(new Error("secret"))).toEqual({
			status: 503,
			error: {
				code: "unavailable",
				message: "Operational inspection is unavailable.",
				retryable: true,
			},
		});
	});
});
describe("bounded safe inspections", () => {
	it("does no startup I/O and avoids missing configuration", async () => {
		const inspect = vi.fn();
		const summary = createOpsInspector([
			{ id: "missing", title: "Missing", isConfigured: () => false, inspect },
		]);
		expect(inspect).not.toHaveBeenCalled();
		expect((await summary()).adapters[0].status).toBe("not-configured");
		expect(inspect).not.toHaveBeenCalled();
	});
	it("isolates errors and discards arbitrary provider details", async () => {
		const summary = createOpsInspector([
			{
				id: "healthy",
				title: "Healthy",
				countNames: ["queued"],
				isConfigured: () => true,
				inspect: async () =>
					({
						status: "ok",
						counts: { queued: 2 },
						secret: "credential",
					}) as never,
			},
			{
				id: "failed",
				title: "Failed",
				isConfigured: () => true,
				inspect: async () => {
					throw new Error("credential");
				},
			},
		]);
		const result = await summary();
		expect(result.adapters.map((x) => x.status)).toEqual(["ok", "unavailable"]);
		expect(JSON.stringify(result)).not.toContain("credential");
	});
	it("rejects invalid registry and unregistered counts", async () => {
		const adapter = {
			id: "test",
			title: "Test",
			isConfigured: () => true,
			inspect: async () => ({ status: "ok" as const, counts: { private: 1 } }),
		};
		expect(() => createOpsInspector([adapter, adapter])).toThrow();
		expect((await createOpsInspector([adapter])()).adapters[0].status).toBe(
			"unavailable",
		);
	});
	it("cancels supported I/O and never multiplies hung work across refreshes", async () => {
		let calls = 0;
		let active = 0;
		let peak = 0;
		const signals: AbortSignal[] = [];
		const summary = createOpsInspector(
			Array.from({ length: 6 }, (_, i) => ({
				id: `adapter-${i}`,
				title: "Adapter",
				isConfigured: () => true,
				inspect: ({ signal }: { signal: AbortSignal }) => {
					signals.push(signal);
					calls++;
					active++;
					peak = Math.max(peak, active);
					return new Promise<never>(() => {});
				},
			})),
		);
		const first = summary();
		await new Promise((resolve) => setTimeout(resolve, 3100));
		expect((await first).adapters.every((x) => x.status === "timeout")).toBe(
			true,
		);
		expect(peak).toBe(3);
		expect(signals.every((x) => x.aborted)).toBe(true);
		const second = summary();
		await new Promise((resolve) => setTimeout(resolve, 3100));
		await second;
		expect(calls).toBe(3);
	}, 10000);
});
