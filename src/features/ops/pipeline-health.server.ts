/**
 * Pipeline health views: owner-scoped (Captures page panel) and the
 * platform-wide operator detail on /admin/ops.
 */
import { listParsers } from "#/features/parsing/registry";
import {
	clip,
	failureRate,
	isFailing,
	type ParserVersionStats,
} from "./health";
import {
	capturesByStatusSource,
	compactionStats,
	connectionCounts,
	enrichmentByStatus,
	exportsByStatus,
	ingressSourceCounts,
	outdatedByParser,
	ownerIngressErrors,
	parserStats,
	readOnly,
} from "./health.server";
import { inspectPipelineQueues } from "./queues.server";
import { listReparseProgress } from "./reparse.server";

function sumByStatus(
	rows: { status: string; last24h: number; last7d: number }[],
) {
	const out: Record<string, { last24h: number; last7d: number }> = {};
	for (const row of rows) {
		const cur = out[row.status] ?? { last24h: 0, last7d: 0 };
		cur.last24h += row.last24h;
		cur.last7d += row.last7d;
		out[row.status] = cur;
	}
	return out;
}

function parserRows(rows: ParserVersionStats[]) {
	const current = new Map(
		listParsers().map((p) => [p.source as string, p.version]),
	);
	return rows.map((r) => ({
		...r,
		parserId: clip(r.parserId),
		currentVersion: current.get(r.parserId) ?? null,
		failurePct: Math.round(failureRate(r) * 100),
		failing: isFailing(r),
	}));
}

export async function getPipelineHealthForOwner(ownerId: string) {
	return readOnly(
		async (tx) => {
			const byStatusSource = await capturesByStatusSource(tx, ownerId);
			const parsers = await parserStats(tx, ownerId);
			const outdated = await outdatedByParser(tx, ownerId);
			const exportRows = await exportsByStatus(tx, ownerId);
			const enrichment = await enrichmentByStatus(tx, ownerId);
			const connections = await connectionCounts(tx, ownerId);
			const ingressErrors = await ownerIngressErrors(tx, ownerId);
			const compaction = await compactionStats(tx, ownerId);
			return {
				checkedAt: new Date().toISOString(),
				captures: {
					byStatus: sumByStatus(byStatusSource),
					bySource: byStatusSource.map((r) => ({
						...r,
						source: clip(r.source),
					})),
				},
				parsers: parserRows(parsers),
				outdated,
				exports: exportRows,
				enrichment,
				connections,
				ingressErrors,
				compaction,
			};
		},
		{ timeoutMs: 5000 },
	);
}
export type PipelineHealth = Awaited<
	ReturnType<typeof getPipelineHealthForOwner>
>;

/** Operator detail: identifiers and counts only (no names, errors, URLs or owners). */
export async function getPipelineDetail() {
	const data = await readOnly(
		async (tx) => ({
			captures: (await capturesByStatusSource(tx)).map((r) => ({
				...r,
				source: clip(r.source),
			})),
			parsers: parserRows(await parserStats(tx)),
			outdated: (await outdatedByParser(tx)).map((r) => ({
				...r,
				parserId: clip(r.parserId),
			})),
			exports: await exportsByStatus(tx),
			enrichment: await enrichmentByStatus(tx),
			ingress: await ingressSourceCounts(tx),
			compaction: await compactionStats(tx),
		}),
		{ timeoutMs: 4000 },
	);
	const reparse = (await listReparseProgress()).map((r) => ({
		parserId: clip(r.parserId),
		targetVersion: r.targetVersion,
		requeued: r.requeued,
		startedAt: r.startedAt.toISOString(),
		completedAt: r.completedAt?.toISOString() ?? null,
	}));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3000);
	const queues = await inspectPipelineQueues(controller.signal)
		.catch(() => null)
		.finally(() => clearTimeout(timer));
	return {
		checkedAt: new Date().toISOString(),
		...data,
		reparse,
		queues,
	};
}
export type PipelineDetail = Awaited<ReturnType<typeof getPipelineDetail>>;
