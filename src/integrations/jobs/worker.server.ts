import type { PgBoss } from "pg-boss";
import { createJobsBoss, workerConcurrency } from "./boss.server";
import { ensureJobQueues } from "./client.server";
import { type JobName, jobRegistry, parseJobPayload } from "./registry";

export interface WorkerOptions {
	execute?: (
		job: { name: JobName; id: string },
		handler: () => Promise<unknown>,
	) => Promise<unknown>;
}

export async function startJobsWorker(
	options: WorkerOptions = {},
): Promise<PgBoss> {
	const concurrency = workerConcurrency();
	const boss = createJobsBoss("worker");
	try {
		await boss.start();
		await ensureJobQueues(boss);

		for (const name of Object.keys(jobRegistry) as JobName[]) {
			await boss.work(
				name,
				{
					includeMetadata: true,
					localConcurrency: concurrency,
					pollingIntervalSeconds: 0.5,
				},
				async ([job]) => {
					if (!job) throw new Error(`Worker received an empty ${name} batch`);
					const context = {
						id: job.id,
						signal: job.signal,
						retryCount: job.retryCount,
						retryLimit: job.retryLimit,
					};
					if (options.execute) {
						return options.execute({ name, id: job.id }, async () => {
							const payload = parseJobPayload(name, job.data);
							return jobRegistry[name].handler(payload as never, context);
						});
					}
					const payload = parseJobPayload(name, job.data);
					console.info(
						JSON.stringify({ event: "job.started", id: job.id, name }),
					);
					try {
						const output = await jobRegistry[name].handler(
							payload as never,
							context,
						);
						console.info(
							JSON.stringify({ event: "job.completed", id: job.id, name }),
						);
						return output;
					} catch (error) {
						console.error(
							JSON.stringify({
								error: "Job handler failed",
								event: "job.failed",
								id: job.id,
								name,
							}),
						);
						throw error;
					}
				},
			);
		}

		console.info(
			JSON.stringify({
				event: "worker.ready",
				queues: Object.keys(jobRegistry),
			}),
		);
		return boss;
	} catch (error) {
		await boss.stop({ graceful: false, timeout: 10_000 }).catch(() => {});
		throw error;
	}
}
