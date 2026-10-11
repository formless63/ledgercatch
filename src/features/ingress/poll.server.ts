import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { sendJob } from "#/integrations/jobs/client.server";
import { ingressSources } from "./schema";
import { getSourceModule } from "./sources/registry.server";

export async function enqueueDuePolls() {
	const now = Date.now();
	const sources = await db
		.select({
			id: ingressSources.id,
			kind: ingressSources.kind,
			intervalMinutes: ingressSources.intervalMinutes,
			lastRunAt: ingressSources.lastRunAt,
		})
		.from(ingressSources)
		.where(eq(ingressSources.enabled, "on"));
	let queued = 0;
	for (const source of sources) {
		if (source.kind === "inbound_email") continue;
		const due =
			!source.lastRunAt ||
			now - source.lastRunAt.getTime() >=
				source.intervalMinutes * 60_000 - 30_000;
		if (!due) continue;
		await sendJob("ingress.poll", { sourceId: source.id });
		queued++;
	}
	return { queued };
}

export async function pollSource(sourceId: string) {
	const [source] = await db
		.select()
		.from(ingressSources)
		.where(
			and(eq(ingressSources.id, sourceId), eq(ingressSources.enabled, "on")),
		);
	if (!source) return { skipped: "missing or disabled" };
	const module = await getSourceModule(source.kind);
	if (!module) return { skipped: "push-only source" };
	try {
		const result = await module.poll(source);
		await db
			.update(ingressSources)
			.set({
				status: "ok",
				lastError: null,
				lastRunAt: new Date(),
				...(result.cursor ? { cursor: result.cursor } : {}),
				updatedAt: new Date(),
			})
			.where(eq(ingressSources.id, sourceId));
		return { created: result.created, summary: result.summary };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(ingressSources)
			.set({
				status: "error",
				lastError: message.slice(0, 2000),
				lastRunAt: new Date(),
			})
			.where(eq(ingressSources.id, sourceId));
		return { failed: message };
	}
}
