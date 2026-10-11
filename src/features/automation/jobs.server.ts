/**
 * Automation jobs and post-handler hooks. Hooks run after an existing job's
 * handler finished (wired in src/integrations/jobs/registry.ts), so ledger
 * code stays untouched and nothing runs inline in requests.
 */
import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	captures,
	connections,
	exports,
	orderCaptures,
	orders,
} from "#/features/ledger/schema";
import { notifications } from "#/integrations/notifications/schema";
import {
	buildCapturePayload,
	buildExportPayload,
	buildOrderPayload,
} from "./webhook-events";

export const automationTickPayload = z.object({}).passthrough();
export const budgetsEvaluatePayload = z.object({
	ownerId: z.string().min(1).max(128),
});
export const paperlessPushPayload = z.object({
	sourceId: z.string().uuid(),
	documentId: z.string().uuid(),
});

const baseUrl = () => process.env.APP_BASE_URL;

/** Hourly: due digests, budget period sweep, Invoice Ninja paid-claim sync. */
export async function handleAutomationTick() {
	const { runDueDigests } = await import("./digest.server");
	const { evaluateBudgetsForOwner, ownersWithBudgets } = await import(
		"./budgets.server"
	);
	const { syncPaidClaims } = await import("./invoice-ninja.server");
	const digests = await runDueDigests();
	let budgetAlerts = 0;
	for (const ownerId of await ownersWithBudgets())
		budgetAlerts += (
			await evaluateBudgetsForOwner(ownerId).catch(() => ({ alerts: 0 }))
		).alerts;
	const claims = await syncPaidClaims().catch(() => ({ paid: 0 }));
	return { ...digests, budgetAlerts, claimsPaid: claims.paid };
}

export async function handleBudgetsEvaluate(
	payload: z.output<typeof budgetsEvaluatePayload>,
) {
	const { evaluateBudgetsForOwner } = await import("./budgets.server");
	return evaluateBudgetsForOwner(payload.ownerId);
}

export async function handlePaperlessPush(
	payload: z.output<typeof paperlessPushPayload>,
) {
	const { runPaperlessPush } = await import("./paperless.server");
	return runPaperlessPush(payload.sourceId, payload.documentId);
}

/** Coalesce budget evaluation per owner (one queued run per 60s window). */
export async function queueBudgetEvaluation(ownerId: string) {
	const { getJobsClient } = await import("#/integrations/jobs/client.server");
	const { jobRegistry } = await import("#/integrations/jobs/registry");
	const boss = await getJobsClient();
	await boss.send(
		"budgets.evaluate",
		{ ownerId },
		{
			...jobRegistry["budgets.evaluate"].queue,
			singletonKey: ownerId,
			singletonSeconds: 60,
			startAfter: 15,
		},
	);
}

async function notifiedRecently(
	ownerId: string,
	type: string,
	minutes: number,
) {
	const [row] = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(
			and(
				eq(notifications.recipientId, ownerId),
				eq(notifications.type, type),
				gte(notifications.createdAt, new Date(Date.now() - minutes * 60_000)),
			),
		)
		.limit(1);
	return !!row;
}

/** After `captures.process`: order.created / capture.failed webhooks, alerts, budgets. */
export async function afterCaptureProcessed(
	captureId: string,
	startedAt: Date,
) {
	const [capture] = await db
		.select()
		.from(captures)
		.where(eq(captures.id, captureId));
	if (!capture) return;
	const { emitLedgerWebhook } = await import("./webhooks.server");
	if (capture.status === "failed") {
		await emitLedgerWebhook(
			capture.ownerId,
			"capture.failed",
			buildCapturePayload(capture, baseUrl()),
		);
		if (!(await notifiedRecently(capture.ownerId, "capture.failed", 60))) {
			const { notifyOwner } = await import("./notify.server");
			await notifyOwner(capture.ownerId, {
				alert: "captureFailures",
				type: "capture.failed",
				title: `Capture failed (${capture.source})`,
				body: `A ${capture.source} capture could not be parsed${capture.error ? `: ${capture.error.slice(0, 300)}` : "."} Further failures are batched for an hour.`,
				link: "/app/captures",
				metadata: { captureId: capture.id },
			}).catch(() => null);
		}
		return;
	}
	const created = await db
		.select({ order: orders })
		.from(orderCaptures)
		.innerJoin(orders, eq(orders.id, orderCaptures.orderId))
		.where(
			and(
				eq(orderCaptures.captureId, captureId),
				gte(orders.firstSeenAt, new Date(startedAt.getTime() - 1_000)),
			),
		);
	for (const { order } of created)
		await emitLedgerWebhook(
			capture.ownerId,
			"order.created",
			buildOrderPayload(order, baseUrl()),
		);
	if (capture.status === "parsed")
		await queueBudgetEvaluation(capture.ownerId).catch(() => {});
}

/** After `exports.push`: export.sent / export.failed webhooks and failure alert. */
export async function afterExportPushed(exportId: string) {
	const [row] = await db
		.select({
			export: exports,
			ownerId: connections.ownerId,
			connectionName: connections.name,
		})
		.from(exports)
		.innerJoin(connections, eq(connections.id, exports.connectionId))
		.where(eq(exports.id, exportId));
	if (!row) return;
	const status = row.export.status;
	if (status !== "sent" && status !== "failed") return;
	const { emitLedgerWebhook } = await import("./webhooks.server");
	await emitLedgerWebhook(
		row.ownerId,
		status === "sent" ? "export.sent" : "export.failed",
		buildExportPayload(row.export),
	);
	if (
		status === "failed" &&
		!(await notifiedRecently(row.ownerId, "export.failed", 60))
	) {
		const { notifyOwner } = await import("./notify.server");
		await notifyOwner(row.ownerId, {
			alert: "exportFailures",
			type: "export.failed",
			title: `Export to ${row.connectionName} failed`,
			body: `${row.export.error?.slice(0, 400) ?? "The export failed."} Further failures are batched for an hour.`,
			link: "/app/settings/connections",
			metadata: { exportId: row.export.id },
		}).catch(() => null);
	}
}
