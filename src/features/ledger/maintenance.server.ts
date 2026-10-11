/** Periodic housekeeping run from the ingress scheduler tick. */
import { and, eq, lt } from "drizzle-orm";
import { db } from "#/db";
import { exports } from "./schema";

/**
 * A push stuck in "sending" means the worker died mid-request. The remote may
 * or may not have the expense, so don't auto-resend: mark it failed with a
 * clear note; a manual re-export runs the connector's duplicate check first.
 */
export async function sweepStuckExports(olderThanMinutes = 15) {
	const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
	const rows = await db
		.update(exports)
		.set({
			status: "failed",
			error:
				"Interrupted while sending. Re-export to retry; the duplicate check prevents double entries.",
		})
		.where(and(eq(exports.status, "sending"), lt(exports.startedAt, cutoff)))
		.returning({ id: exports.id });
	return { swept: rows.length };
}
