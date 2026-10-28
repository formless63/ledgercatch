import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { db } from "#/db";
import { assertTransactionalJobsDatabase, createJobsBoss } from "./boss.server";
import { type JobName, type JobPayload, jobRegistry } from "./registry";

type AppTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

import { createJobsLifecycle } from "./lifecycle.server";

export async function ensureJobQueues(boss: PgBoss) {
	const names = Object.keys(jobRegistry) as JobName[];
	await Promise.all(
		names.map((name) =>
			boss.createQueue(name, { ...jobRegistry[name].queue, notify: true }),
		),
	);
	// createQueue leaves existing options unchanged. Upgrade the wakeup flag alone,
	// preserving existing retention/retry policies and every queued job.
	const queues = await boss.getQueues(names);
	await Promise.all(
		queues
			.filter((queue) => !queue.notify)
			.map((queue) => boss.updateQueue(queue.name, { notify: true })),
	);
}
const lifecycle = createJobsLifecycle(
	() => createJobsBoss("producer"),
	ensureJobQueues,
);
export const getJobsClient = lifecycle.get;
export const stopJobsClient = lifecycle.stop;

export async function sendJob<TName extends JobName>(
	name: TName,
	payload: JobPayload<TName>,
) {
	const parsed = jobRegistry[name].payload.parse(payload);
	const boss = await getJobsClient();
	const id = await boss.send(name, parsed, jobRegistry[name].queue);
	if (!id) throw new Error(`pg-boss did not create ${name}`);
	return id;
}

export async function sendJobInTransaction<TName extends JobName>(
	tx: AppTransaction,
	name: TName,
	payload: JobPayload<TName>,
) {
	assertTransactionalJobsDatabase();
	const parsed = jobRegistry[name].payload.parse(payload);
	const boss = await getJobsClient();
	const id = await boss.send(name, parsed, {
		...jobRegistry[name].queue,
		db: fromDrizzle(tx, sql),
	});
	if (!id) throw new Error(`pg-boss did not create ${name}`);
	return id;
}
