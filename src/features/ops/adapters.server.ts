/**
 * Application-owned Ops/Admin adapters for the capture → order → export
 * pipeline (IDEAS #2). Platform-wide counts only: no payloads, URLs, names,
 * errors or owner ids leave these functions. Registered in
 * src/lib/ops-adapters.server.ts.
 */

import { listParsers } from "#/features/parsing/registry";
import type {
	Inspection,
	OpsAdapter,
} from "#/integrations/ops-admin/ops.server";
import { opsJobsConfigured } from "#/lib/ops-jobs.server";
import { failureRate, isFailing, machineName } from "./health";
import {
	capturesByStatusSource,
	compactionStats,
	connectionCounts,
	enrichmentByStatus,
	exportsByStatus,
	ingressSourceCounts,
	outdatedByParser,
	parserStats,
	readOnly,
} from "./health.server";
import { inspectPipelineQueues, PIPELINE_QUEUES } from "./queues.server";
import { listReparseProgress } from "./reparse.server";

type Ctx = { signal: AbortSignal };
const always = () => true;

const CAPTURE_COUNTS = [
	"total",
	"parsed",
	"failed",
	"needs-review",
	"no-orders",
	"pending",
	"ignored",
] as const;

function captureWindow(window: "last24h" | "last7d") {
	return async ({ signal }: Ctx): Promise<Inspection> => {
		const rows = await readOnly((tx) => capturesByStatusSource(tx), {
			signal,
		});
		const counts: Record<string, number> = Object.fromEntries(
			CAPTURE_COUNTS.map((n) => [n, 0]),
		);
		for (const row of rows) {
			const n = row[window];
			counts.total = (counts.total ?? 0) + n;
			const key = machineName(row.status);
			if (key && key in counts) counts[key] = (counts[key] ?? 0) + n;
		}
		const bad = (counts.failed ?? 0) + (counts["needs-review"] ?? 0);
		const total = counts.total ?? 0;
		return {
			status: bad >= 5 && total > 0 && bad / total >= 0.2 ? "degraded" : "ok",
			counts,
		};
	};
}

const parserIds = listParsers()
	.map((p) => machineName(p.source))
	.filter((x): x is string => x !== null && x !== "outdated")
	.slice(0, 7);

export const pipelineOpsAdapters: OpsAdapter[] = [
	{
		id: "captures-24h",
		title: "Captures received, last 24 hours",
		countNames: CAPTURE_COUNTS,
		isConfigured: always,
		inspect: captureWindow("last24h"),
	},
	{
		id: "captures-7d",
		title: "Captures received, last 7 days",
		countNames: CAPTURE_COUNTS,
		isConfigured: always,
		inspect: captureWindow("last7d"),
	},
	{
		id: "parser-failures",
		title: "Parser failure rate per parser version, last 7 days",
		countNames: [
			"parser-versions",
			"failing",
			"attempts",
			"failed",
			"needs-review",
			"worst-failure-pct",
		],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const rows = await readOnly((tx) => parserStats(tx), { signal });
			const counts = {
				"parser-versions": rows.length,
				failing: rows.filter(isFailing).length,
				attempts: rows.reduce((a, r) => a + r.total, 0),
				failed: rows.reduce((a, r) => a + r.failed, 0),
				"needs-review": rows.reduce((a, r) => a + r.needsReview, 0),
				"worst-failure-pct": Math.round(
					100 *
						Math.max(0, ...rows.filter((r) => r.total >= 5).map(failureRate)),
				),
			};
			return { status: counts.failing > 0 ? "degraded" : "ok", counts };
		},
	},
	{
		id: "parsers-outdated",
		title: "Captures parsed by an older parser version",
		countNames: ["outdated", ...parserIds],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const rows = await readOnly((tx) => outdatedByParser(tx), { signal });
			const counts: Record<string, number> = { outdated: 0 };
			for (const id of parserIds) counts[id] = 0;
			for (const row of rows) {
				counts.outdated = (counts.outdated ?? 0) + row.outdated;
				const key = machineName(row.parserId);
				if (key && key in counts)
					counts[key] = (counts[key] ?? 0) + row.outdated;
			}
			return { status: "ok", counts };
		},
	},
	{
		id: "auto-reparse",
		title: "Auto-reparse progress after parser version bumps",
		countNames: ["parsers-tracked", "in-progress", "requeued"],
		isConfigured: always,
		inspect: async ({ signal }) => {
			if (signal.aborted) throw new Error("aborted");
			const rows = await listReparseProgress();
			return {
				status: "ok",
				counts: {
					"parsers-tracked": rows.length,
					"in-progress": rows.filter((r) => !r.completedAt).length,
					requeued: rows.reduce((a, r) => a + Math.max(0, r.requeued), 0),
				},
			};
		},
	},
	{
		id: "exports",
		title: "Accounting exports by status",
		countNames: [
			"queued",
			"sending",
			"stuck-sending",
			"failed",
			"stale",
			"skipped",
			"sent",
			"sent-24h",
		],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const rows = await readOnly((tx) => exportsByStatus(tx), { signal });
			const counts: Record<string, number> = {
				queued: 0,
				sending: 0,
				"stuck-sending": 0,
				failed: 0,
				stale: 0,
				skipped: 0,
				sent: 0,
				"sent-24h": 0,
			};
			for (const row of rows) {
				if (row.status in counts) counts[row.status] = row.n;
				counts["stuck-sending"] = (counts["stuck-sending"] ?? 0) + row.stuck;
				counts["sent-24h"] = (counts["sent-24h"] ?? 0) + row.sent24h;
			}
			return {
				status:
					(counts["stuck-sending"] ?? 0) > 0 || (counts.failed ?? 0) > 0
						? "degraded"
						: "ok",
				counts,
			};
		},
	},
	{
		id: "enrichment",
		title: "Enrichment tasks by status",
		countNames: [
			"pending",
			"claimed",
			"stale-claimed",
			"done",
			"failed",
			"skipped",
		],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const rows = await readOnly((tx) => enrichmentByStatus(tx), { signal });
			const counts: Record<string, number> = {
				pending: 0,
				claimed: 0,
				"stale-claimed": 0,
				done: 0,
				failed: 0,
				skipped: 0,
			};
			for (const row of rows) {
				if (row.status in counts) counts[row.status] = row.n;
				counts["stale-claimed"] =
					(counts["stale-claimed"] ?? 0) + row.staleClaimed;
			}
			return {
				status: (counts["stale-claimed"] ?? 0) > 0 ? "degraded" : "ok",
				counts,
			};
		},
	},
	{
		id: "ingress-sources",
		title: "Ingress sources (mail, Paperless, store APIs)",
		countNames: ["total", "enabled", "error", "error-enabled", "untested"],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const rows = await readOnly((tx) => ingressSourceCounts(tx), { signal });
			const counts = {
				total: 0,
				enabled: 0,
				error: 0,
				"error-enabled": 0,
				untested: 0,
			};
			for (const row of rows) {
				counts.total += row.n;
				if (row.enabled === "on") counts.enabled += row.n;
				if (row.status === "error") counts.error += row.n;
				if (row.status === "error" && row.enabled === "on")
					counts["error-enabled"] += row.n;
				if (row.status === "untested") counts.untested += row.n;
			}
			return {
				status: counts["error-enabled"] > 0 ? "degraded" : "ok",
				counts,
			};
		},
	},
	{
		id: "connections",
		title: "Accounting connections",
		countNames: ["total", "enabled", "error"],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const counts = await readOnly((tx) => connectionCounts(tx), { signal });
			return { status: counts.error > 0 ? "degraded" : "ok", counts };
		},
	},
	{
		id: "pipeline-queues",
		title: "Pipeline job queues (cached counts, sample time unknown)",
		countNames: [
			...PIPELINE_QUEUES.map((n) => n.replace(/\./g, "-")),
			"active",
			"failed",
		],
		isConfigured: opsJobsConfigured,
		inspect: async ({ signal }) => {
			const queues = await inspectPipelineQueues(signal);
			const counts: Record<string, number> = { active: 0, failed: 0 };
			for (const q of queues) {
				counts[q.name.replace(/\./g, "-")] = q.queued;
				counts.active = (counts.active ?? 0) + q.active;
				counts.failed = (counts.failed ?? 0) + q.failed;
			}
			return { status: "ok", counts };
		},
	},
	{
		id: "capture-compaction",
		title: "Compacted capture bodies in object storage",
		countNames: ["compacted", "compacted-mib"],
		isConfigured: always,
		inspect: async ({ signal }) => {
			const stats = await readOnly((tx) => compactionStats(tx), { signal });
			return {
				status: "ok",
				counts: {
					compacted: stats.compacted,
					"compacted-mib": Math.round(stats.bytes / (1024 * 1024)),
				},
			};
		},
	},
];
