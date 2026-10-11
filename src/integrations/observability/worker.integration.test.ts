import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import { it } from "vitest";

it("exports actual successful/failed worker task signals when SIGTERM drains and flushes", async () => {
	const schema = `obs_test_${crypto.randomUUID().replaceAll("-", "")}`;
	const received: string[] = [];
	const sink = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		received.push(Buffer.concat(chunks).toString());
		response.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
	const database = process.env.DATABASE_URL;
	assert.ok(database, "Use a disposable migrated test database");
	const environment = {
		...process.env,
		PGBOSS_DATABASE_URL: database,
		PGBOSS_SCHEMA: schema,
		OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(sink.address() as AddressInfo).port}`,
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_SDK_DISABLED: "false",
	};
	const boss = new PgBoss({
		connectionString: database,
		schema,
		migrate: false,
		schedule: false,
		supervise: false,
	});
	let worker: ReturnType<typeof spawn> | undefined;
	let output = "";
	try {
		await promisify(execFile)("bun", ["scripts/jobs-migrate.ts"], {
			env: environment,
		});
		await boss.start();
		worker = spawn("bun", ["scripts/jobs-worker.ts"], {
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		});
		worker.stdout?.on("data", (chunk) => {
			output += chunk;
		});
		worker.stderr?.on("data", (chunk) => {
			output += chunk;
		});
		let ended = false;
		const exit = new Promise<number | null>((resolve, reject) => {
			worker?.once("error", reject);
			worker?.once("exit", (code) => {
				ended = true;
				resolve(code);
			});
		});
		async function waitFor(predicate: () => Promise<boolean> | boolean) {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (await predicate()) return;
				assert.ok(!ended, "Worker exited before completion");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error("Worker verification timed out");
		}
		await waitFor(() => output.includes("worker.ready"));
		const success = await boss.send("health.probe", {
			message: "worker-payload-secret",
		});
		const failure = await boss.send("health.probe", { message: "" });
		assert.ok(success && failure);
		await waitFor(async () => {
			const jobs = await boss.findJobs("health.probe");
			return (
				jobs.some((job) => job.id === success && job.state === "completed") &&
				jobs.some((job) => job.id === failure && job.state === "failed")
			);
		});
		worker.kill("SIGTERM");
		const timeout = setTimeout(() => worker?.kill("SIGKILL"), 8_000);
		try {
			assert.equal(await exit, 0);
		} finally {
			clearTimeout(timeout);
		}
		const signals = received.join("");
		assert.ok(signals.includes("resourceSpans"));
		assert.ok(signals.includes("job health.probe"));
		assert.ok(signals.includes("job.execution.count"));
		assert.ok(signals.includes("job.failure.count"));
		assert.ok(signals.includes("Operation failed"));
		assert.ok(!signals.includes("worker-payload-secret"));
		assert.ok(!output.includes("worker-payload-secret"));
		const records = output
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line));
		assert.ok(
			records.some((record) => record.jobId === success && record.traceId),
		);
		assert.ok(
			records.some((record) => record.jobId === failure && record.traceId),
		);
		assert.ok(output.includes("Worker stopped"));
	} finally {
		if (worker && worker.exitCode === null) worker.kill("SIGKILL");
		await boss.stop({ graceful: true, timeout: 2_000 });
		const pool = new Pool({ connectionString: database });
		try {
			await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		} finally {
			await pool.end();
		}
		await new Promise<void>((resolve) => sink.close(() => resolve()));
	}
}, 35_000);
