/**
 * Sign-up allowance for invited grantees. Deliberately tiny (db + schema only)
 * so src/lib/auth.ts can import it without an import cycle.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "#/db";
import { entityShares } from "./schema";
import { normalizeEmail } from "./scope";

/**
 * True when `email` has a live, unexpired, not-yet-accepted entity share
 * invite. Used by the Better Auth `user.create.before` hook so an invited
 * accountant can create an account although sign-up is otherwise closed.
 */
export async function isInvitedEmail(email: string): Promise<boolean> {
	const normalized = normalizeEmail(email);
	if (!normalized) return false;
	const [row] = await db
		.select({ id: entityShares.id })
		.from(entityShares)
		.where(
			and(
				eq(entityShares.granteeEmail, normalized),
				isNull(entityShares.revokedAt),
				isNull(entityShares.acceptedUserId),
				gt(entityShares.tokenExpiresAt, new Date()),
			),
		)
		.limit(1);
	return !!row;
}
