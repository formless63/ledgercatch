import { describe, expect, it } from "vitest";
import { alertToSend, budgetLevel, periodWindow, progressPct } from "./budgets";
import {
	alertEnabled,
	buildDigest,
	type DigestCounts,
	digestDue,
	localClock,
} from "./digest";
import { WEBHOOK_EVENT_TYPES } from "./inputs";
import {
	buildCapturePayload,
	buildClaimPayload,
	buildExportPayload,
	buildLedgerWebhook,
	buildOrderPayload,
	endpointWants,
	LEDGER_WEBHOOK_TYPES,
} from "./webhook-events";

const empty: DigestCounts = {
	inbox: 0,
	missingInvoices: 0,
	pendingReimbursements: [],
	exports: { failed: 0, stale: 0 },
	captures: { failed: 0, needsReview: 0 },
	enrichment: 0,
};

describe("digest", () => {
	it("returns null when nothing needs attention", () => {
		expect(buildDigest(empty, {})).toBeNull();
	});

	it("lists every non-zero section with links", () => {
		const digest = buildDigest(
			{
				inbox: 3,
				missingInvoices: 1,
				pendingReimbursements: [
					{
						entityName: "BusinessCo",
						currency: "USD",
						totalMinor: 12_345,
						count: 2,
					},
				],
				exports: { failed: 1, stale: 2 },
				captures: { failed: 2, needsReview: 1 },
				enrichment: 4,
			},
			{},
			"https://ot.example/",
		);
		expect(digest?.lines.map((l) => l.kind)).toEqual([
			"inbox",
			"missingInvoices",
			"pendingReimbursements",
			"exports",
			"captures",
			"enrichment",
		]);
		expect(digest?.body).toContain(
			"3 orders waiting in the inbox — https://ot.example/app",
		);
		expect(digest?.body).toContain("1 assigned order older than 3 days");
		expect(digest?.body).toContain(
			"BusinessCo: $123.45 pending reimbursement (2 allocations)",
		);
		expect(digest?.body).toContain(
			"Exports need attention: 1 failed, 2 out of date",
		);
		expect(digest?.body).toContain("Captures: 2 failed, 1 need review");
		expect(digest?.title).toBe("LedgerCatch: 6 items need attention");
		expect(digest?.body).not.toMatch(/<[a-z]/i);
	});

	it("respects disabled alerts", () => {
		const digest = buildDigest(
			{ ...empty, inbox: 2, enrichment: 1 },
			{ inbox: false },
		);
		expect(digest?.lines.map((l) => l.kind)).toEqual(["enrichment"]);
		expect(alertEnabled(undefined, "inbox")).toBe(true);
		expect(alertEnabled({ inbox: false }, "inbox")).toBe(false);
	});

	it("is due once per local day at or after the chosen hour", () => {
		const now = new Date("2026-10-08T13:30:00Z");
		expect(localClock(now, "America/New_York")).toEqual({
			date: "2026-10-08",
			hour: 9,
		});
		expect(localClock(now, "Not/AZone")).toEqual({
			date: "2026-10-08",
			hour: 13,
		});
		expect(
			digestDue({
				now,
				timeZone: "America/New_York",
				digestHour: 8,
				lastDigestDate: null,
			}).due,
		).toBe(true);
		expect(
			digestDue({
				now,
				timeZone: "America/New_York",
				digestHour: 10,
				lastDigestDate: null,
			}).due,
		).toBe(false);
		expect(
			digestDue({
				now,
				timeZone: "America/New_York",
				digestHour: 8,
				lastDigestDate: "2026-10-08",
			}).due,
		).toBe(false);
	});
});

describe("budgets", () => {
	it("computes calendar windows", () => {
		const now = new Date("2026-11-15T12:00:00Z");
		expect(periodWindow("month", now)).toEqual({
			key: "2026-11",
			start: "2026-11-01",
			end: "2026-12-01",
		});
		expect(periodWindow("month", new Date("2026-12-31T23:00:00Z")).end).toBe(
			"2027-01-01",
		);
		expect(periodWindow("quarter", now)).toEqual({
			key: "2026-Q4",
			start: "2026-10-01",
			end: "2027-01-01",
		});
		expect(periodWindow("quarter", new Date("2026-05-02T00:00:00Z"))).toEqual({
			key: "2026-Q2",
			start: "2026-04-01",
			end: "2026-07-01",
		});
		expect(periodWindow("year", now)).toEqual({
			key: "2026",
			start: "2026-01-01",
			end: "2027-01-01",
		});
	});

	it("classifies spend against thresholds", () => {
		expect(budgetLevel(79_99, 100_00, 80)).toBe("ok");
		expect(budgetLevel(80_00, 100_00, 80)).toBe("threshold");
		expect(budgetLevel(100_00, 100_00, 80)).toBe("threshold");
		expect(budgetLevel(100_01, 100_00, 80)).toBe("exceeded");
		expect(budgetLevel(1, 0, 80)).toBe("exceeded");
		expect(progressPct(50, 200)).toBe(25);
		expect(progressPct(1, 3)).toBe(33.3);
	});

	it("alerts once per level per period", () => {
		const base = {
			periodKey: "2026-10",
			alertedPeriod: null,
			alertedLevel: null,
		} as const;
		expect(alertToSend({ ...base, level: "ok" })).toBeNull();
		expect(alertToSend({ ...base, level: "threshold" })).toBe("threshold");
		expect(
			alertToSend({
				...base,
				level: "threshold",
				alertedPeriod: "2026-10",
				alertedLevel: "threshold",
			}),
		).toBeNull();
		expect(
			alertToSend({
				...base,
				level: "exceeded",
				alertedPeriod: "2026-10",
				alertedLevel: "threshold",
			}),
		).toBe("exceeded");
		expect(
			alertToSend({
				...base,
				level: "exceeded",
				alertedPeriod: "2026-10",
				alertedLevel: "exceeded",
			}),
		).toBeNull();
		expect(
			alertToSend({
				...base,
				level: "exceeded",
				alertedPeriod: "2026-09",
				alertedLevel: "exceeded",
			}),
		).toBe("exceeded");
	});
});

describe("webhook payloads", () => {
	const orderRow = {
		id: "0b5f3c3e-8a0e-4c39-9d2f-6f3b8f1a2c11",
		source: "amazon",
		externalOrderId: "111-222",
		merchantName: "Amazon",
		orderDate: "2026-10-01",
		status: "shipped",
		reviewState: "filed",
		entityId: "5d0f3c3e-8a0e-4c39-9d2f-6f3b8f1a2c11",
		categoryId: null,
		totalMinor: 4_299,
		currency: "USD",
	};

	it("builds a signed-envelope-ready order event", () => {
		const { event, body } = buildLedgerWebhook(
			"order.filed",
			buildOrderPayload(orderRow, "https://ot.example/"),
		);
		expect(event.type).toBe("order.filed");
		expect(JSON.parse(body).data.url).toBe(
			`https://ot.example/app/orders/${orderRow.id}`,
		);
		expect(JSON.parse(body).data.totalMinor).toBe(4_299);
	});

	it("builds claim, export and capture events", () => {
		const claim = buildLedgerWebhook(
			"claim.paid",
			buildClaimPayload({
				id: orderRow.id,
				status: "paid",
				payerEntityId: orderRow.entityId,
				owingEntityId: orderRow.entityId,
				currency: "USD",
				totalMinor: 100,
				reference: null,
				submittedAt: new Date("2026-10-01T00:00:00Z"),
				paidAt: "2026-10-02T00:00:00.000Z",
			}),
		);
		expect(JSON.parse(claim.body).data.submittedAt).toBe(
			"2026-10-01T00:00:00.000Z",
		);
		const exp = buildLedgerWebhook(
			"export.failed",
			buildExportPayload({
				id: orderRow.id,
				connectionId: orderRow.id,
				orderId: null,
				entityId: null,
				amountMinor: null,
				status: "failed",
				remoteId: null,
				remoteUrl: null,
				error: "x".repeat(5000),
			}),
		);
		expect(JSON.parse(exp.body).data.error).toHaveLength(1000);
		const capture = buildLedgerWebhook(
			"capture.failed",
			buildCapturePayload({
				id: orderRow.id,
				source: "generic",
				channel: "extension",
				kind: "html_snapshot",
				status: "failed",
				error: "No parser",
				pageUrl: "https://shop.example/orders/1",
			}),
		);
		expect(JSON.parse(capture.body).data.url).toBe("/app/captures");
	});

	it("rejects payloads outside the registry schema", () => {
		expect(() =>
			buildLedgerWebhook("order.created", {
				...buildOrderPayload(orderRow),
				extra: true,
			} as never),
		).toThrow();
	});

	it("keeps the client-safe event list in sync with the registry", () => {
		expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual(
			[...LEDGER_WEBHOOK_TYPES].sort(),
		);
	});

	it("filters endpoint subscriptions", () => {
		expect(endpointWants([], "order.created")).toBe(true);
		expect(endpointWants(["claim.paid"], "order.created")).toBe(false);
	});
});
