import { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "#/db";
import { createJobsBoss, jobsDatabaseUrl } from "./boss.server";
import { sendJobInTransaction, stopJobsClient } from "./client.server";
import { startJobsWorker } from "./worker.server";

const pool = new Pool({ connectionString: jobsDatabaseUrl() });
const previousNotify = process.env.PGBOSS_USE_LISTEN_NOTIFY;
let producer: PgBoss;
let worker: PgBoss;

async function completed(ids: string[], timeout = 4_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const jobs = await producer.findJobs<{ message: string }>("health.probe");
		const selected = jobs.filter((job) => ids.includes(job.id));
		if (selected.some((job) => job.state === "failed")) {
			throw new Error("Probe failed");
		}
		if (
			selected.length === ids.length &&
			selected.every((job) => job.state === "completed")
		) {
			for (const job of selected) {
				expect(job.output).toEqual({ echoed: job.data.message });
			}
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Probe completion exceeded the delivery bound");
}

describe("low-CPU queue delivery", () => {
	beforeAll(async () => {
		delete process.env.PGBOSS_USE_LISTEN_NOTIFY;
		producer = createJobsBoss("producer");
		await producer.start();
		// An existing queue must acquire notifications without losing operator policy.
		await producer.createQueue("health.probe", {
			notify: false,
			retryLimit: 7,
		});
		await producer.updateQueue("health.probe", {
			notify: false,
			retryLimit: 7,
		});
		worker = await startJobsWorker();
	});

	afterAll(async () => {
		await worker?.stop({ graceful: true, timeout: 10_000 });
		// Do not leave the deliberate operator-policy fixture for other test files.
		await producer?.updateQueue("health.probe", { retryLimit: 0 });
		await producer?.stop({ graceful: true, timeout: 10_000 });
		await stopJobsClient();
		await pool.end();
		if (previousNotify === undefined)
			delete process.env.PGBOSS_USE_LISTEN_NOTIFY;
		else process.env.PGBOSS_USE_LISTEN_NOTIFY = previousNotify;
	});

	it("upgrades existing queue wakeups without changing its retry policy", async () => {
		const queue = await producer.getQueue("health.probe");
		expect(queue?.notify).toBe(true);
		expect(queue?.retryLimit).toBe(7);
	});

	it("keeps an empty 18-queue worker below the former busy-poll transaction rate", async () => {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const commits = async () => {
			const { rows } = await pool.query<{ commits: string }>(
				"SELECT xact_commit::text AS commits FROM pg_stat_database WHERE datname=current_database()",
			);
			return Number(rows[0]?.commits);
		};
		const before = await commits();
		await new Promise((resolve) => setTimeout(resolve, 8_000));
		// Allows a full backstop sweep plus statistics lag; the old worker exceeds 1,000.
		expect((await commits()) - before).toBeLessThan(150);
	}, 15_000);

	it("wakes after a commit and drains a burst larger than local concurrency promptly", async () => {
		const ids: string[] = [];
		await db.transaction(async (tx) => {
			for (let i = 0; i < 16; i++) {
				ids.push(
					await sendJobInTransaction(tx, "health.probe", {
						message: `burst-${i}`,
					}),
				);
			}
		});
		await completed(ids);
	}, 10_000);

	it("finds a future-due job through the bounded notification backstop", async () => {
		const id = await producer.send(
			"health.probe",
			{ message: "delayed" },
			{ startAfter: 1 },
		);
		if (!id) throw new Error("Probe enqueue failed");
		await completed([id], 13_000);
	}, 15_000);

	it("still consumes with notifications explicitly disabled", async () => {
		await worker.stop({ graceful: true, timeout: 10_000 });
		process.env.PGBOSS_USE_LISTEN_NOTIFY = "false";
		worker = await startJobsWorker();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const id = await producer.send("health.probe", {
			message: "poll-fallback",
		});
		if (!id) throw new Error("Probe enqueue failed");
		await completed([id], 7_000);
	}, 12_000);
});
