/**
 * Per-queue pg-boss cached counts for the application's own job names
 * (Ops/Admin only). Same contract as src/lib/ops-jobs.server.ts: a separate
 * read-only connection, no producer/worker start, no queue creation.
 */
import pg from "pg";
import { PgBoss } from "pg-boss";
import { jobsDatabaseUrl, jobsSchema } from "#/integrations/jobs/boss.server";

export const PIPELINE_QUEUES = [
	"captures.process",
	"exports.push",
	"ingress.tick",
	"ingress.poll",
	"imports.process",
	"enrichment.provider",
] as const;

export type QueueDepth = {
	name: string;
	queued: number;
	active: number;
	failed: number;
};

export async function inspectPipelineQueues(
	signal?: AbortSignal,
): Promise<QueueDepth[]> {
	const client = new pg.Client({
		connectionString: jobsDatabaseUrl(),
		connectionTimeoutMillis: 2000,
		options: "-c default_transaction_read_only=on -c statement_timeout=2000",
	});
	const abort = () => {
		void client.end().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) throw new Error("aborted");
		await client.connect();
		if (signal?.aborted) throw new Error("aborted");
		const boss = new PgBoss({
			schema: jobsSchema(),
			migrate: false,
			supervise: false,
			schedule: false,
			db: { executeSql: (text, values) => client.query(text, values) },
		});
		const queues = await boss.getQueues([...PIPELINE_QUEUES]);
		const byName = new Map(queues.map((q) => [q.name, q]));
		return PIPELINE_QUEUES.map((name) => {
			const q = byName.get(name);
			return {
				name,
				queued: q?.queuedCount ?? 0,
				active: q?.activeCount ?? 0,
				failed: q?.failedCount ?? 0,
			};
		});
	} finally {
		signal?.removeEventListener("abort", abort);
		await client.end().catch(() => {});
	}
}
