import { jobRegistry } from "../src/integrations/jobs/registry";
import { startJobsWorker } from "../src/integrations/jobs/worker.server";

const boss = await startJobsWorker();
const message = `smoke-${crypto.randomUUID()}`;

async function waitForCompletion(id: string) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const [job] = await boss.findJobs<{ message: string }>("health.probe", { id });
		if (job?.state === "completed") return job;
		if (job?.state === "failed") throw new Error(`Smoke job failed: ${JSON.stringify(job.output)}`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Timed out waiting for the smoke job");
}

try {
	const id = await boss.send("health.probe", { message }, jobRegistry["health.probe"].queue);
	if (!id) throw new Error("pg-boss did not create the smoke job");
	const job = await waitForCompletion(id);
	const output = job.output as { echoed?: unknown };
	if (output.echoed !== message) throw new Error(`Unexpected smoke output: ${JSON.stringify(job.output)}`);
	console.info(JSON.stringify({ event: "jobs.smoke_passed", id, output: job.output }));
} finally {
	await boss.stop({ graceful: true, timeout: 10_000 });
}
