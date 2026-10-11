import pg from "pg";
import { PgBoss } from "pg-boss";
import { jobsDatabaseUrl, jobsSchema } from "#/integrations/jobs/boss.server";
import { jobRegistry } from "#/integrations/jobs/registry";
export function opsJobsConfigured() {
	try {
		const url = new URL(jobsDatabaseUrl());
		jobsSchema();
		return (
			["postgres:", "postgresql:"].includes(url.protocol) &&
			Boolean(url.hostname) &&
			Boolean(url.pathname.slice(1)) &&
			Object.keys(jobRegistry).length <= 32
		);
	} catch {
		return false;
	}
}
/** Supported cached metadata only; never start the producer/worker or create queues.
 * Abort closes the actual PostgreSQL connection; statement_timeout independently bounds server-side work.
 */
export async function inspectOpsJobs({ signal }: { signal: AbortSignal }) {
	const names = Object.keys(jobRegistry);
	if (names.length > 32) throw new Error();
	const client = new pg.Client({
		connectionString: jobsDatabaseUrl(),
		connectionTimeoutMillis: 2000,
		options: "-c default_transaction_read_only=on -c statement_timeout=2000",
	});
	const abort = () => {
		void client.end().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) throw new Error();
		await client.connect();
		if (signal.aborted) throw new Error();
		const boss = new PgBoss({
			schema: jobsSchema(),
			migrate: false,
			supervise: false,
			schedule: false,
			db: { executeSql: (text, values) => client.query(text, values) },
		});
		const queues = await boss.getQueues(names);
		const counts = { queued: 0, active: 0, failed: 0 };
		for (const queue of queues) {
			counts.queued += queue.queuedCount;
			counts.active += queue.activeCount;
			counts.failed += queue.failedCount;
		}
		return { status: "ok" as const, counts };
	} finally {
		signal.removeEventListener("abort", abort);
		await client.end().catch(() => {});
	}
}
