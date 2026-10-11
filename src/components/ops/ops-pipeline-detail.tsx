/**
 * Operator-only pipeline breakdown on /admin/ops (identifiers and counts
 * only). The server function re-checks the OPS_ADMIN_USER_IDS allowlist.
 */
import { useEffect, useRef, useState } from "react";
import { loadOpsPipelineDetail } from "#/features/ops/ops.functions";

type Result = Awaited<ReturnType<typeof loadOpsPipelineDetail>>;
type Detail = Extract<Result, { ok: true }>["detail"];

function Table({
	caption,
	head,
	rows,
}: {
	caption: string;
	head: string[];
	rows: (string | number | null)[][];
}) {
	return (
		<section className="rounded-lg border p-4" aria-label={caption}>
			<h3 className="mb-2 font-semibold">{caption}</h3>
			{rows.length === 0 ? (
				<p className="text-sm opacity-70">None.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm tabular-nums">
						<thead>
							<tr>
								{head.map((h) => (
									<th key={h} className="pr-4 font-medium">
										{h}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.join("|")}>
									{row.map((cell, i) => (
										<td key={head[i]} className="pr-4">
											{cell ?? "—"}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

export function OpsPipelineDetail({ refreshKey }: { refreshKey: string }) {
	const [result, setResult] = useState<Result | null>(null);
	const generation = useRef(0);
	useEffect(() => {
		const current = ++generation.current;
		void refreshKey;
		loadOpsPipelineDetail()
			.then((next) => {
				if (current === generation.current) setResult(next);
			})
			.catch(() => {
				if (current === generation.current)
					setResult({
						ok: false,
						error: {
							code: "unavailable",
							message: "Operational inspection is unavailable.",
							retryable: true,
						},
					});
			});
	}, [refreshKey]);

	if (!result) return <p>Loading pipeline detail…</p>;
	if (!result.ok) return <p role="alert">{result.error.message}</p>;
	const d: Detail = result.detail;
	return (
		<div className="space-y-4">
			<h2 className="text-xl font-semibold">Pipeline detail</h2>
			<div className="grid gap-4 lg:grid-cols-2">
				<Table
					caption="Captures by source and status"
					head={["source", "status", "24h", "7d"]}
					rows={d.captures
						.slice()
						.sort((a, b) => b.last7d - a.last7d)
						.slice(0, 60)
						.map((r) => [r.source, r.status, r.last24h, r.last7d])}
				/>
				<Table
					caption="Parse outcomes per parser version (7 days)"
					head={[
						"parser",
						"version",
						"current",
						"total",
						"failed",
						"review",
						"no orders",
						"fail %",
					]}
					rows={d.parsers
						.slice(0, 60)
						.map((r) => [
							r.parserId,
							r.parserVersion,
							r.currentVersion,
							r.total,
							r.failed,
							r.needsReview,
							r.noOrders,
							`${r.failurePct}%${r.failing ? " !" : ""}`,
						])}
				/>
				<Table
					caption="Captures parsed by an older parser version"
					head={["parser", "current", "outdated", "auto re-parse eligible"]}
					rows={d.outdated.map((r) => [
						r.parserId,
						r.currentVersion,
						r.outdated,
						r.autoEligible,
					])}
				/>
				<Table
					caption="Auto-reparse progress"
					head={["parser", "version", "requeued", "started", "completed"]}
					rows={d.reparse.map((r) => [
						r.parserId,
						r.targetVersion,
						r.requeued,
						r.startedAt,
						r.completedAt,
					])}
				/>
				<Table
					caption="Exports by status"
					head={["status", "count", "stuck sending", "sent 24h"]}
					rows={d.exports.map((r) => [r.status, r.n, r.stuck, r.sent24h])}
				/>
				<Table
					caption="Enrichment tasks by status"
					head={["status", "count", "stale claims"]}
					rows={d.enrichment.map((r) => [r.status, r.n, r.staleClaimed])}
				/>
				<Table
					caption="Ingress sources"
					head={["kind", "status", "enabled", "count"]}
					rows={d.ingress.map((r) => [r.kind, r.status, r.enabled, r.n])}
				/>
				<Table
					caption="Job queues (cached counts)"
					head={["queue", "queued", "active", "failed"]}
					rows={(d.queues ?? []).map((q) => [
						q.name,
						q.queued,
						q.active,
						q.failed,
					])}
				/>
			</div>
			<p className="text-sm">
				Compacted capture bodies: {d.compaction.compacted} (
				{Math.round(d.compaction.bytes / 1024 / 1024)} MiB moved to object
				storage). Checked <time dateTime={d.checkedAt}>{d.checkedAt}</time>.
			</p>
		</div>
	);
}
