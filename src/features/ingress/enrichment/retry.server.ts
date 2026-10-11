import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { publishLedgerEvent } from "#/features/ledger/events.server";
import { type Actor, audit, type Tx } from "#/features/ledger/orders.server";
import { enrichmentTasks } from "../schema";

/** A deliberate retry gets a fresh bounded attempt budget; active work is untouched. */
export async function retryFailedEnrichmentInTransactionForOwner(
	tx: Tx,
	ownerId: string,
	source?: string,
	actor: Actor = { type: "user", id: ownerId },
) {
	const rows = await tx
		.update(enrichmentTasks)
		.set({
			status: "pending",
			attempts: 0,
			lastError: null,
			claimedAt: null,
			finishedAt: null,
		})
		.where(
			and(
				eq(enrichmentTasks.ownerId, ownerId),
				eq(enrichmentTasks.kind, "extension_fetch"),
				eq(enrichmentTasks.status, "failed"),
				source ? eq(enrichmentTasks.source, source) : undefined,
			),
		)
		.returning({ id: enrichmentTasks.id, orderId: enrichmentTasks.orderId });
	for (const row of rows)
		await audit(tx, actor, "enrichment.retried", row.orderId, {
			taskId: row.id,
		});
	return { requeued: rows.length };
}
export async function retryFailedEnrichmentForOwner(ownerId: string) {
	const result = await db.transaction((tx) =>
		retryFailedEnrichmentInTransactionForOwner(tx, ownerId),
	);
	if (result.requeued)
		publishLedgerEvent(ownerId, { type: "orders", orderIds: [], created: 0 });
	return result;
}
