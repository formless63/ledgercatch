import { createJobsBoss, jobsSchema } from "../src/integrations/jobs/boss.server";

const boss = createJobsBoss("migration");

try {
	await boss.start();
	console.info(JSON.stringify({ event: "jobs.migrated", schema: jobsSchema(), version: await boss.schemaVersion() }));
} finally {
	await boss.stop({ graceful: true, timeout: 10_000 });
}
