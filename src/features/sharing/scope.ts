/**
 * Pure grantee-scoping rules for entity shares. Server modules use these to
 * decide what a viewer may see; they are unit-tested in scope.test.ts.
 * Nothing here touches the database.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const INVITE_TTL_MS = 14 * 86_400_000;
/** Document kinds a viewer may download (no page snapshots / screenshots). */
export const SHARED_DOCUMENT_KINDS = ["invoice", "receipt"] as const;

export function normalizeEmail(email: string) {
	return email.trim().toLowerCase();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string) {
	const value = normalizeEmail(email);
	return value.length <= 254 && EMAIL.test(value);
}

export function generateShareToken() {
	return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string) {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatches(token: string, expectedHash: string | null) {
	if (!expectedHash) return false;
	const actual = Buffer.from(hashShareToken(token), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type ShareState = {
	ownerId: string;
	granteeEmail: string;
	tokenHash: string | null;
	tokenExpiresAt: Date | null;
	acceptedUserId: string | null;
	revokedAt: Date | null;
};

export type ShareStatus = "pending" | "expired" | "active" | "revoked";

export function shareStatus(share: ShareState, now = new Date()): ShareStatus {
	if (share.revokedAt) return "revoked";
	if (share.acceptedUserId) return "active";
	if (!share.tokenExpiresAt || share.tokenExpiresAt <= now) return "expired";
	return "pending";
}

export type AcceptanceFailure =
	| "invalid_token"
	| "revoked"
	| "expired"
	| "already_accepted"
	| "email_mismatch"
	| "email_unverified"
	| "self_share";

/** May `viewer` accept `share` with `token`? Email binding is mandatory. */
export function evaluateAcceptance(
	share: ShareState,
	token: string,
	viewer: { id: string; email: string; emailVerified: boolean },
	now = new Date(),
): { ok: true } | { ok: false; reason: AcceptanceFailure } {
	if (share.revokedAt) return { ok: false, reason: "revoked" };
	if (share.acceptedUserId)
		return {
			ok: false,
			reason:
				share.acceptedUserId === viewer.id
					? "already_accepted"
					: "invalid_token",
		};
	if (!tokenMatches(token, share.tokenHash))
		return { ok: false, reason: "invalid_token" };
	if (!share.tokenExpiresAt || share.tokenExpiresAt <= now)
		return { ok: false, reason: "expired" };
	if (viewer.id === share.ownerId) return { ok: false, reason: "self_share" };
	if (normalizeEmail(viewer.email) !== normalizeEmail(share.granteeEmail))
		return { ok: false, reason: "email_mismatch" };
	if (!viewer.emailVerified) return { ok: false, reason: "email_unverified" };
	return { ok: true };
}

/** Is this share a live grant for `userId`? (The only gate for portal reads.) */
export function grantsAccess(share: ShareState, userId: string) {
	return (
		!share.revokedAt &&
		!!share.acceptedUserId &&
		share.acceptedUserId === userId
	);
}

/** Sign-up is allowed for an email with a live, unexpired, unaccepted invite. */
export function inviteAllowsSignup(share: ShareState, now = new Date()) {
	return shareStatus(share, now) === "pending";
}

/** Items a viewer of `entityId` may see: those attributed to that entity. */
export function itemsForEntity<
	T extends { entityId: string | null | undefined },
>(items: readonly T[], primaryEntityId: string | null, entityId: string): T[] {
	return items.filter(
		(item) => (item.entityId ?? primaryEntityId) === entityId,
	);
}

/**
 * The viewer's slice of an order's allocations: own amount only, plus a
 * "shared" flag when any other entity also has an allocation. Other entities'
 * ids/amounts never leave this function.
 */
export function allocationSlice<
	A extends { entityId: string; amountMinor: number },
>(
	allocations: readonly A[],
	entityId: string,
): { own: A | null; shared: boolean } {
	const own = allocations.find((a) => a.entityId === entityId) ?? null;
	return {
		own,
		shared: allocations.some((a) => a.entityId !== entityId),
	};
}

/** Viewer may see a claim only when its entity is a party to it. */
export function claimInvolves(
	claim: { payerEntityId: string; owingEntityId: string },
	entityId: string,
) {
	return claim.payerEntityId === entityId || claim.owingEntityId === entityId;
}

/** Calendar month bucket ("2026-03") for an ISO date string. */
export function monthOf(isoDate: string | null | undefined) {
	return isoDate && /^\d{4}-\d{2}/.test(isoDate)
		? isoDate.slice(0, 7)
		: "undated";
}

export function monthlyTotals(
	rows: ReadonlyArray<{
		orderDate: string | null;
		currency: string;
		amountMinor: number;
	}>,
) {
	const totals = new Map<
		string,
		{ month: string; currency: string; totalMinor: number; count: number }
	>();
	for (const row of rows) {
		const month = monthOf(row.orderDate);
		const key = `${month}|${row.currency}`;
		const bucket = totals.get(key) ?? {
			month,
			currency: row.currency,
			totalMinor: 0,
			count: 0,
		};
		bucket.totalMinor += row.amountMinor;
		bucket.count += 1;
		totals.set(key, bucket);
	}
	return [...totals.values()].sort((a, b) =>
		a.month === b.month
			? a.currency.localeCompare(b.currency)
			: b.month.localeCompare(a.month),
	);
}
