import { describe, expect, it } from "vitest";
import {
	allocationSlice,
	claimInvolves,
	evaluateAcceptance,
	grantsAccess,
	hashShareToken,
	inviteAllowsSignup,
	isValidEmail,
	itemsForEntity,
	monthlyTotals,
	normalizeEmail,
	type ShareState,
	shareStatus,
	tokenMatches,
} from "./scope";

const now = new Date("2026-10-01T12:00:00Z");
const token = "tok_abcdefghijklmnopqrstuvwxyz0123456789";
const pending: ShareState = {
	ownerId: "owner",
	granteeEmail: "cpa@example.com",
	tokenHash: hashShareToken(token),
	tokenExpiresAt: new Date("2026-10-10T00:00:00Z"),
	acceptedUserId: null,
	revokedAt: null,
};
const viewer = { id: "cpa", email: "CPA@Example.com ", emailVerified: true };

describe("share status", () => {
	it("derives pending / expired / active / revoked", () => {
		expect(shareStatus(pending, now)).toBe("pending");
		expect(
			shareStatus({ ...pending, tokenExpiresAt: new Date("2026-09-01") }, now),
		).toBe("expired");
		expect(shareStatus({ ...pending, acceptedUserId: "cpa" }, now)).toBe(
			"active",
		);
		expect(
			shareStatus(
				{ ...pending, acceptedUserId: "cpa", revokedAt: new Date() },
				now,
			),
		).toBe("revoked");
	});
});

describe("evaluateAcceptance", () => {
	it("accepts the right token for the invited, verified email", () => {
		expect(evaluateAcceptance(pending, token, viewer, now)).toEqual({
			ok: true,
		});
	});
	it("rejects a wrong token", () => {
		expect(evaluateAcceptance(pending, `${token}x`, viewer, now)).toEqual({
			ok: false,
			reason: "invalid_token",
		});
	});
	it("binds to the invited email (forwarded links do not work)", () => {
		expect(
			evaluateAcceptance(
				pending,
				token,
				{ ...viewer, email: "someone@else.com" },
				now,
			),
		).toEqual({ ok: false, reason: "email_mismatch" });
	});
	it("requires a verified email", () => {
		expect(
			evaluateAcceptance(
				pending,
				token,
				{ ...viewer, emailVerified: false },
				now,
			),
		).toEqual({ ok: false, reason: "email_unverified" });
	});
	it("rejects expired, revoked, self and reused invites", () => {
		expect(
			evaluateAcceptance(pending, token, viewer, new Date("2026-11-01")),
		).toEqual({ ok: false, reason: "expired" });
		expect(
			evaluateAcceptance({ ...pending, revokedAt: now }, token, viewer, now),
		).toEqual({ ok: false, reason: "revoked" });
		expect(
			evaluateAcceptance(pending, token, { ...viewer, id: "owner" }, now),
		).toEqual({ ok: false, reason: "self_share" });
		expect(
			evaluateAcceptance(
				{ ...pending, acceptedUserId: "other", tokenHash: null },
				token,
				viewer,
				now,
			),
		).toEqual({ ok: false, reason: "invalid_token" });
		expect(
			evaluateAcceptance(
				{ ...pending, acceptedUserId: "cpa", tokenHash: null },
				token,
				viewer,
				now,
			),
		).toEqual({ ok: false, reason: "already_accepted" });
	});
	it("compares token hashes safely", () => {
		expect(tokenMatches(token, null)).toBe(false);
		expect(tokenMatches(token, "abc")).toBe(false);
		expect(tokenMatches(token, hashShareToken(token))).toBe(true);
	});
});

describe("grantsAccess", () => {
	const active = { ...pending, acceptedUserId: "cpa", tokenHash: null };
	it("grants only the accepted user while not revoked", () => {
		expect(grantsAccess(active, "cpa")).toBe(true);
		expect(grantsAccess(active, "owner")).toBe(false);
		expect(grantsAccess(active, "someone")).toBe(false);
		expect(grantsAccess(pending, "cpa")).toBe(false);
		expect(grantsAccess({ ...active, revokedAt: now }, "cpa")).toBe(false);
	});
	it("allows sign-up only for live pending invites", () => {
		expect(inviteAllowsSignup(pending, now)).toBe(true);
		expect(inviteAllowsSignup(active, now)).toBe(false);
		expect(inviteAllowsSignup({ ...pending, revokedAt: now }, now)).toBe(false);
		expect(inviteAllowsSignup(pending, new Date("2027-01-01"))).toBe(false);
	});
});

describe("grantee data scoping", () => {
	it("shows only the viewer's own allocation and a shared flag", () => {
		const slice = allocationSlice(
			[
				{ entityId: "biz", amountMinor: 700 },
				{ entityId: "personal", amountMinor: 300 },
			],
			"biz",
		);
		expect(slice.own).toEqual({ entityId: "biz", amountMinor: 700 });
		expect(slice.shared).toBe(true);
		expect(JSON.stringify(slice)).not.toContain("personal");
		expect(JSON.stringify(slice)).not.toContain("300");
	});
	it("reports no access when the entity has no allocation", () => {
		expect(
			allocationSlice([{ entityId: "personal", amountMinor: 1 }], "biz").own,
		).toBeNull();
	});
	it("is not shared when the viewer's entity holds the whole order", () => {
		expect(
			allocationSlice([{ entityId: "biz", amountMinor: 1 }], "biz").shared,
		).toBe(false);
	});
	it("filters items to the viewer's entity (overrides and primary)", () => {
		const items = [
			{ id: "a", entityId: null },
			{ id: "b", entityId: "personal" },
			{ id: "c", entityId: "biz" },
		];
		expect(itemsForEntity(items, "biz", "biz").map((i) => i.id)).toEqual([
			"a",
			"c",
		]);
		expect(itemsForEntity(items, "personal", "biz").map((i) => i.id)).toEqual([
			"c",
		]);
		expect(itemsForEntity(items, null, "biz").map((i) => i.id)).toEqual(["c"]);
	});
	it("only exposes claims the entity is a party to", () => {
		expect(
			claimInvolves({ payerEntityId: "biz", owingEntityId: "p" }, "biz"),
		).toBe(true);
		expect(
			claimInvolves({ payerEntityId: "p", owingEntityId: "biz" }, "biz"),
		).toBe(true);
		expect(
			claimInvolves({ payerEntityId: "p", owingEntityId: "q" }, "biz"),
		).toBe(false);
	});
});

describe("helpers", () => {
	it("normalizes and validates emails", () => {
		expect(normalizeEmail("  A@B.Co ")).toBe("a@b.co");
		expect(isValidEmail("a@b.co")).toBe(true);
		expect(isValidEmail("nope")).toBe(false);
	});
	it("groups monthly totals per currency, newest first", () => {
		expect(
			monthlyTotals([
				{ orderDate: "2026-01-05", currency: "USD", amountMinor: 100 },
				{ orderDate: "2026-01-20", currency: "USD", amountMinor: 50 },
				{ orderDate: "2026-02-01", currency: "EUR", amountMinor: 10 },
				{ orderDate: null, currency: "USD", amountMinor: 1 },
			]),
		).toEqual([
			{ month: "undated", currency: "USD", totalMinor: 1, count: 1 },
			{ month: "2026-02", currency: "EUR", totalMinor: 10, count: 1 },
			{ month: "2026-01", currency: "USD", totalMinor: 150, count: 2 },
		]);
	});
});
