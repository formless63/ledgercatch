/**
 * Best-effort outbound events (webhooks, Invoice Ninja drafts, Paperless push).
 * Never throws: ledger writes must not fail because a downstream hook did.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { captures, claims, connections, exports, orders } from "./schema";

const baseUrl = () => process.env.APP_BASE_URL;

async function quietly(run: () => Promise<unknown>) {
	try {
		await run();
	} catch {
		/* downstream failures are visible in their own delivery logs */
	}
}

export function emitOrderEvent(
	ownerId: string,
	orderId: string,
	type: "order.created" | "order.filed" | "order.assigned",
) {
	return quietly(async () => {
		const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
		if (!row || row.ownerId !== ownerId) return;
		const { emitLedgerWebhook } = await import(
			"#/features/automation/webhooks.server"
		);
		const { buildOrderPayload } = await import(
			"#/features/automation/webhook-events"
		);
		await emitLedgerWebhook(ownerId, type, buildOrderPayload(row, baseUrl()));
	});
}

export function emitClaimPaid(ownerId: string, claimId: string) {
	return quietly(async () => {
		const [row] = await db.select().from(claims).where(eq(claims.id, claimId));
		if (!row || row.ownerId !== ownerId) return;
		const { emitLedgerWebhook } = await import(
			"#/features/automation/webhooks.server"
		);
		const { buildClaimPayload } = await import(
			"#/features/automation/webhook-events"
		);
		await emitLedgerWebhook(
			ownerId,
			"claim.paid",
			buildClaimPayload(row, baseUrl()),
		);
	});
}

export function afterClaims(ownerId: string, claimIds: string[]) {
	return quietly(async () => {
		const { afterClaimsCreated } = await import(
			"#/features/automation/invoice-ninja.server"
		);
		await afterClaimsCreated(ownerId, claimIds);
	});
}

export function emitExportEvent(exportId: string) {
	return quietly(async () => {
		const [row] = await db
			.select({ export: exports, ownerId: connections.ownerId })
			.from(exports)
			.innerJoin(connections, eq(connections.id, exports.connectionId))
			.where(eq(exports.id, exportId));
		if (!row) return;
		const type =
			row.export.status === "sent"
				? "export.sent"
				: row.export.status === "failed"
					? "export.failed"
					: null;
		if (!type) return;
		const { emitLedgerWebhook } = await import(
			"#/features/automation/webhooks.server"
		);
		const { buildExportPayload } = await import(
			"#/features/automation/webhook-events"
		);
		await emitLedgerWebhook(row.ownerId, type, buildExportPayload(row.export));
	});
}

export function emitCaptureFailed(captureId: string) {
	return quietly(async () => {
		const [row] = await db
			.select()
			.from(captures)
			.where(eq(captures.id, captureId));
		if (!row || row.status !== "failed") return;
		const { emitLedgerWebhook } = await import(
			"#/features/automation/webhooks.server"
		);
		const { buildCapturePayload } = await import(
			"#/features/automation/webhook-events"
		);
		await emitLedgerWebhook(
			row.ownerId,
			"capture.failed",
			buildCapturePayload(row, baseUrl()),
		);
	});
}

export function afterDocument(ownerId: string, documentId: string) {
	return quietly(async () => {
		const { afterDocumentStored } = await import(
			"#/features/automation/paperless.server"
		);
		await afterDocumentStored(ownerId, documentId);
	});
}
