import { db } from "../src/db";
import { installParserFlagGate } from "../src/features/automation/parser-flags.server";
import { startJobsWorker } from "../src/integrations/jobs/worker.server";
import { observeJob } from "../src/integrations/observability/http.server";
import { getLogger, initObservability, shutdownObservability } from "../src/integrations/observability/runtime.server";

initObservability({ registerSignals: false });
const boss = await startJobsWorker({ execute: observeJob });
if (process.env.LEDGERCATCH_DEMO !== "true") {
// Poll ingress sources (IMAP, Paperless, store APIs) on a schedule.
await boss.schedule("ingress.tick", "*/5 * * * *", {});
// Hourly: daily digests (per-user local hour), budget sweep, Invoice Ninja paid-claim sync.
await boss.schedule("automation.tick", "7 * * * *", {});
// Shipment tracking refresh (skips cleanly without TRACKING_API_KEY).
await boss.schedule("tracking.refresh", "15 */6 * * *", {});
// ECB reference rates are published ~16:00 CET on business days.
await boss.schedule("money.fx_refresh", "30 16 * * 1-5", {});
}
// Parser feature flags (parser.<source>.v<version>) gate the registry in this process.
await installParserFlagGate().catch(() => {});
let stopping = false;

async function stop(signal: NodeJS.Signals) {
	if (stopping) return;
	stopping = true;
	getLogger().info({ component: "jobs", signal }, "Worker stopping");
	try { await boss.stop({ graceful: true, timeout: 30_000 }); }
	finally { await db.$client.end(); await shutdownObservability(); }
	getLogger().info({ component: "jobs" }, "Worker stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void stop(signal).catch((error) => {
			getLogger().error({ err: error }, "Worker stop failed");
			process.exitCode = 1;
		});
	});
}
