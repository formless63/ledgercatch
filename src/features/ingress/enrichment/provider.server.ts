/**
 * Job `enrichment.provider { taskId }`: complete one order through a store
 * API source (currently DigiKey Order Status v4). The API response becomes a
 * capture, so the normal pipeline merges it into the order.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { enrichmentTasks, ingressSources } from "../schema";
import { MAX_ENRICHMENT_ATTEMPTS } from "./urls";

async function finish(
	taskId: string,
	status: "done" | "failed" | "skipped" | "pending",
	lastError: string | null,
) {
	await db
		.update(enrichmentTasks)
		.set({
			status,
			lastError: lastError?.slice(0, 2000) ?? null,
			finishedAt: status === "pending" ? null : new Date(),
			claimedAt: null,
		})
		.where(eq(enrichmentTasks.id, taskId));
}

export async function runProviderEnrichment(taskId: string) {
	// Claim atomically so duplicate jobs don't both run.
	const [task] = await db
		.update(enrichmentTasks)
		.set({
			status: "claimed",
			claimedAt: new Date(),
			attempts: sql`${enrichmentTasks.attempts} + 1`,
		})
		.where(
			and(
				eq(enrichmentTasks.id, taskId),
				eq(enrichmentTasks.kind, "provider_api"),
				eq(enrichmentTasks.status, "pending"),
			),
		)
		.returning();
	if (!task)
		return { skipped: "task missing, not pending, or not a provider task" };

	if (task.source !== "digikey") {
		await finish(taskId, "skipped", `no API provider for ${task.source}`);
		return { skipped: `no provider for ${task.source}` };
	}
	const [source] = await db
		.select()
		.from(ingressSources)
		.where(
			and(
				eq(ingressSources.ownerId, task.ownerId),
				eq(ingressSources.kind, "digikey_api"),
				eq(ingressSources.enabled, "on"),
			),
		)
		.limit(1);
	if (!source) {
		await finish(taskId, "skipped", "no enabled DigiKey API source");
		return { skipped: "no enabled DigiKey API source" };
	}
	try {
		const { fetchDigikeySalesOrder } = await import(
			"../sources/digikey.server"
		);
		const result = await fetchDigikeySalesOrder(source, task.externalOrderId);
		await finish(taskId, "done", null);
		return { done: true, captureId: result.captureId, created: result.created };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Transient failures get another job run (pg-boss retry) until attempts run out.
		const retry =
			task.attempts < MAX_ENRICHMENT_ATTEMPTS && !/HTTP 4\d\d/.test(message);
		await finish(taskId, retry ? "pending" : "failed", message);
		if (retry) throw error;
		return { failed: message };
	}
}
