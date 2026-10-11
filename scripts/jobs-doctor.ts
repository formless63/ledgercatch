import { createJobsBoss, jobsSchema } from "../src/integrations/jobs/boss.server";

const boss = createJobsBoss("admin");

try {
	await boss.start();
	const [version, drift] = await Promise.all([boss.schemaVersion(), boss.detectSchemaDrift()]);
	console.info(JSON.stringify({ event: "jobs.doctor", schema: jobsSchema(), version, drift }));
	if (!drift.ok) process.exitCode = 1;
} finally {
	await boss.stop({ graceful: true, timeout: 10_000 });
}
