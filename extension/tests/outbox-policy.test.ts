import { describe, expect, it } from "vitest";
import {
	BACKOFF_BASE_MS,
	BACKOFF_MAX_MS,
	MAX_ATTEMPTS,
	afterRetryableFailure,
	backoffDelayMs,
	classifyStatus,
	parseRetryAfter,
	resetForManualRetry,
	selectDue,
} from "@/lib/outbox-policy";

const noJitter = () => 0.5; // jitter factor exactly 1

describe("classifyStatus", () => {
	it.each([
		[200, "ok"],
		[201, "ok"],
		[401, "auth"],
		[403, "auth"],
		[409, "permanent"],
		[422, "permanent"],
		[400, "permanent"],
		[413, "permanent"],
		[404, "retry"],
		[429, "retry"],
		[500, "retry"],
		[503, "retry"],
	] as const)("%i -> %s", (status, outcome) => {
		expect(classifyStatus(status)).toBe(outcome);
	});
});

describe("backoffDelayMs", () => {
	it("doubles from the base and caps", () => {
		expect(backoffDelayMs(1, noJitter)).toBe(BACKOFF_BASE_MS);
		expect(backoffDelayMs(2, noJitter)).toBe(BACKOFF_BASE_MS * 2);
		expect(backoffDelayMs(5, noJitter)).toBe(BACKOFF_BASE_MS * 16);
		expect(backoffDelayMs(30, noJitter)).toBe(BACKOFF_MAX_MS);
	});
	it("applies +/-20% jitter", () => {
		expect(backoffDelayMs(1, () => 0)).toBe(BACKOFF_BASE_MS * 0.8);
		expect(backoffDelayMs(1, () => 1)).toBe(BACKOFF_BASE_MS * 1.2);
		expect(backoffDelayMs(30, () => 1)).toBe(BACKOFF_MAX_MS);
	});
});

describe("parseRetryAfter", () => {
	const now = Date.parse("2026-10-08T12:00:00Z");
	it("parses seconds and dates", () => {
		expect(parseRetryAfter("120", now)).toBe(120_000);
		expect(parseRetryAfter("Thu, 08 Oct 2026 12:01:00 GMT", now)).toBe(60_000);
		expect(parseRetryAfter("garbage", now)).toBeNull();
		expect(parseRetryAfter(null, now)).toBeNull();
	});
});

describe("afterRetryableFailure", () => {
	const fresh = { attempts: 0, nextAttemptAt: 0, status: "pending" as const };
	it("schedules the next attempt with backoff", () => {
		const next = afterRetryableFailure(fresh, "HTTP 503", 1000, null, noJitter);
		expect(next).toEqual({ attempts: 1, nextAttemptAt: 1000 + BACKOFF_BASE_MS, status: "pending", lastError: "HTTP 503" });
	});
	it("honours a longer Retry-After", () => {
		const next = afterRetryableFailure(fresh, "429", 0, 10 * 60_000, noJitter);
		expect(next.nextAttemptAt).toBe(10 * 60_000);
	});
	it("gives up after MAX_ATTEMPTS", () => {
		const next = afterRetryableFailure({ ...fresh, attempts: MAX_ATTEMPTS - 1 }, "boom", 0, null, noJitter);
		expect(next.status).toBe("failed");
		expect(next.nextAttemptAt).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("selectDue / resetForManualRetry", () => {
	const items = [
		{ id: "b", createdAt: 2, attempts: 0, nextAttemptAt: 0, status: "pending" as const },
		{ id: "a", createdAt: 1, attempts: 1, nextAttemptAt: 50, status: "pending" as const },
		{ id: "c", createdAt: 0, attempts: 2, nextAttemptAt: 500, status: "pending" as const },
		{ id: "d", createdAt: 0, attempts: 12, nextAttemptAt: Number.POSITIVE_INFINITY, status: "failed" as const },
	];
	it("returns due pending items oldest first", () => {
		expect(selectDue(items, 100).map((i) => i.id)).toEqual(["a", "b"]);
	});
	it("manual retry makes everything due and refreshes the failed budget", () => {
		const reset = items.map((i) => resetForManualRetry(i, 100));
		expect(selectDue(reset, 100).map((i) => i.id).sort()).toEqual(["a", "b", "c", "d"]);
		expect(reset.find((i) => i.id === "d")?.attempts).toBe(0);
		expect(reset.find((i) => i.id === "c")?.attempts).toBe(2);
	});
});
