import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { entities, user } from "#/db/schema";
import { observeJob } from "../observability/http.server";
import {
	getJobsClient,
	sendJobInTransaction,
	stopJobsClient,
} from "./client.server";
import { jobRegistry } from "./registry";
import type { JobHandlerContext } from "./types";
import { startJobsWorker } from "./worker.server";

const ownerId = `jobs-owner-${crypto.randomUUID()}`;
const committedEntityId = crypto.randomUUID();
const rolledBackEntityId = crypto.randomUUID();
let worker: PgBoss;

async function waitForJob(id: string, state: string, queue = "health.probe") {
	const boss = await getJobsClient();
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const [job] = await boss.findJobs(queue, { id });
		if (job?.state === state) return job;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for job state ${state}`);
}

describe("transactional jobs", () => {
	beforeAll(async () => {
		await db.insert(user).values({
			id: ownerId,
			name: "Jobs owner",
			email: `${ownerId}@example.test`,
		});
		worker = await startJobsWorker({ execute: observeJob });
	});

	afterAll(async () => {
		await worker.stop({ graceful: true, timeout: 10_000 });
		const boss = await getJobsClient();
		await boss.deleteAllJobs("health.probe");
		await db.delete(user).where(eq(user.id, ownerId));
		await stopJobsClient();
	});

	it("commits the application write and job atomically", async () => {
		let jobId = "";
		await db.transaction(async (tx) => {
			await tx.insert(entities).values({
				id: committedEntityId,
				ownerId,
				name: "Committed with job",
				kind: "business",
			});
			jobId = await sendJobInTransaction(tx, "health.probe", {
				message: "committed",
			});
		});
		const [entity] = await db
			.select()
			.from(entities)
			.where(eq(entities.id, committedEntityId));
		const boss = await getJobsClient();
		const [job] = await boss.findJobs("health.probe", { id: jobId });
		expect(entity?.name).toBe("Committed with job");
		expect(job?.id).toBe(jobId);
	});

	it("rolls back the application write and job atomically", async () => {
		let jobId = "";
		await expect(
			db.transaction(async (tx) => {
				await tx.insert(entities).values({
					id: rolledBackEntityId,
					ownerId,
					name: "Rolled back with job",
					kind: "business",
				});
				jobId = await sendJobInTransaction(tx, "health.probe", {
					message: "rolled back",
				});
				throw new Error("intentional rollback");
			}),
		).rejects.toThrow("intentional rollback");
		const [entity] = await db
			.select()
			.from(entities)
			.where(eq(entities.id, rolledBackEntityId));
		const boss = await getJobsClient();
		const [job] = await boss.findJobs("health.probe", { id: jobId });
		expect(entity).toBeUndefined();
		expect(job).toBeUndefined();
	});

	it("refuses mismatched routing before enqueue and rolls back the real transaction", async () => {
		const domain = process.env.DATABASE_URL;
		if (!domain)
			throw new Error("DATABASE_URL is required for Jobs integration tests");
		const previous = process.env.PGBOSS_DATABASE_URL;
		const boss = await getJobsClient();
		try {
			for (const [key, value] of [
				["host", "other.invalid"],
				["port", "1"],
			]) {
				const entityId = crypto.randomUUID(),
					message = `routing-refusal-${entityId}`;
				const routed = new URL(domain);
				routed.searchParams.set(key, value);
				process.env.PGBOSS_DATABASE_URL = routed.toString();
				await expect(
					db.transaction(async (tx) => {
						await tx.insert(entities).values({
							id: entityId,
							ownerId,
							name: "Routing refusal",
							kind: "business",
						});
						await sendJobInTransaction(tx, "health.probe", { message });
					}),
				).rejects.toThrow("Jobs database configuration is invalid");
				expect(
					await db.select().from(entities).where(eq(entities.id, entityId)),
				).toEqual([]);
				expect(
					(await boss.findJobs("health.probe")).some(
						(job) => (job.data as { message?: string }).message === message,
					),
				).toBe(false);
			}
		} finally {
			if (previous === undefined) delete process.env.PGBOSS_DATABASE_URL;
			else process.env.PGBOSS_DATABASE_URL = previous;
		}
	});

	it("fails payloads that bypass the typed enqueue boundary", async () => {
		const boss = await getJobsClient();
		const id = await boss.send("health.probe", { message: "" });
		if (!id) throw new Error("pg-boss did not create the invalid test job");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const [job] = await boss.findJobs("health.probe", { id });
			if (job?.state === "failed") {
				expect(job.output).toBeDefined();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Timed out waiting for invalid job to fail");
	});

	it("forwards native per-job retry metadata through the optional execution hook", async () => {
		const attempts: JobHandlerContext[] = [];
		const original = jobRegistry["health.probe"].handler;
		const handler = vi
			.spyOn(jobRegistry["health.probe"], "handler")
			.mockImplementation(async (payload, context) => {
				if (payload.message !== "retry-context") return original(payload);
				if (!context) throw new Error("Missing handler context");
				attempts.push(context);
				if (context.retryCount === 0) throw new Error("Retry this attempt");
				return { echoed: payload.message };
			});
		try {
			const boss = await getJobsClient();
			const id = await boss.send(
				"health.probe",
				{ message: "retry-context" },
				{ retryLimit: 2, retryDelay: 0 },
			);
			if (!id) throw new Error("Missing test job");
			const completed = await waitForJob(id, "completed");
			expect(completed.retryCount).toBe(1);
			expect(
				attempts.map(({ id, retryCount, retryLimit }) => ({
					id,
					retryCount,
					retryLimit,
				})),
			).toEqual([
				{ id, retryCount: 0, retryLimit: 2 },
				{ id, retryCount: 1, retryLimit: 2 },
			]);
			expect(
				attempts.every(({ signal }) => signal instanceof AbortSignal),
			).toBe(true);
		} finally {
			handler.mockRestore();
		}
	});

	it("forwards expiration cancellation and retains native retry settlement", async () => {
		const attempts: JobHandlerContext[] = [];
		const original = jobRegistry["health.probe"].handler;
		const handler = vi
			.spyOn(jobRegistry["health.probe"], "handler")
			.mockImplementation(async (payload, context) => {
				if (payload.message !== "expire-context") return original(payload);
				if (!context) throw new Error("Missing handler context");
				attempts.push(context);
				if (context.retryCount === 0) {
					await new Promise<void>((_, reject) =>
						context.signal.addEventListener(
							"abort",
							() => reject(context.signal.reason),
							{ once: true },
						),
					);
				}
				return { echoed: payload.message };
			});
		try {
			const boss = await getJobsClient();
			const id = await boss.send(
				"health.probe",
				{ message: "expire-context" },
				{ retryLimit: 1, retryDelay: 0, expireInSeconds: 1 },
			);
			if (!id) throw new Error("Missing test job");
			expect((await waitForJob(id, "completed")).retryCount).toBe(1);
			expect(attempts[0]?.signal.aborted).toBe(true);
			expect(attempts.map(({ retryCount }) => retryCount)).toEqual([0, 1]);
		} finally {
			handler.mockRestore();
		}
	});

	it("cancels an active handler on close and leaves its retry available to a replacement worker", async () => {
		let started!: (context: JobHandlerContext) => void;
		const running = new Promise<JobHandlerContext>((resolve) => {
			started = resolve;
		});
		const original = jobRegistry["health.probe"].handler;
		const handler = vi
			.spyOn(jobRegistry["health.probe"], "handler")
			.mockImplementation(async (payload, context) => {
				if (payload.message !== "close-context" || context?.retryCount !== 0)
					return original(payload);
				started(context);
				await new Promise<void>((_, reject) =>
					context.signal.addEventListener(
						"abort",
						() => reject(context.signal.reason),
						{ once: true },
					),
				);
				return {};
			});
		try {
			const boss = await getJobsClient();
			const id = await boss.send(
				"health.probe",
				{ message: "close-context" },
				{ retryLimit: 1, retryDelay: 0 },
			);
			if (!id) throw new Error("Missing test job");
			const context = await running;
			await worker.stop({ graceful: false, close: true });
			expect(context.id).toBe(id);
			expect(context.signal.aborted).toBe(true);
			expect((await waitForJob(id, "retry")).retryLimit).toBe(1);
			// The replacement exercises dispatch without the optional telemetry hook too.
			worker = await startJobsWorker();
			expect((await waitForJob(id, "completed")).retryCount).toBe(1);
		} finally {
			handler.mockRestore();
		}
	});
});
