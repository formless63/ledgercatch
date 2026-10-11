/**
 * "Pipeline health" panel for the Captures page: the signed-in user's own
 * capture outcomes, parser failures, captures waiting for an automatic
 * re-parse, exports, enrichment and ingress source errors.
 */
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	formatBytes,
	formatRelative,
	storeLabel,
} from "#/components/app/format";
import { Button, Panel, StatTile, Tag } from "#/components/app/primitives";
import { errorText } from "#/components/settings/ui";
import { retryFailedEnrichment } from "#/features/ingress/enrichment/retry.functions";
import { useInvalidateLedger } from "#/features/ledger/hooks";
import { getPipelineHealth } from "#/features/ops/ops.functions";
import { cn } from "#/lib/utils";
import { UnsupportedOrders } from "./unsupported-orders";

export const pipelineHealthKey = ["ledger", "pipeline-health"] as const;

function count(rows: { status: string; n: number }[], status: string) {
	return rows.find((r) => r.status === status)?.n ?? 0;
}

export function PipelineHealth({ className }: { className?: string }) {
	const query = useQuery({
		queryKey: pipelineHealthKey,
		queryFn: () => getPipelineHealth(),
		refetchInterval: 60_000,
		staleTime: 30_000,
	});
	const data = query.data;
	const invalidate = useInvalidateLedger();
	const retry = useMutation({
		mutationFn: () => retryFailedEnrichment(),
		onSuccess: async (result) => {
			toast.success(`${result.requeued} failed fetches requeued`);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const action = (
		<Button
			variant="ghost"
			size="xs"
			onClick={() => void query.refetch()}
			aria-label="Refresh pipeline health"
		>
			<IconRefresh className={query.isFetching ? "animate-spin" : ""} />
		</Button>
	);

	if (query.isError)
		return (
			<Panel title="Pipeline health" action={action} className={className}>
				<p className="text-xs text-muted-foreground">
					Pipeline health is unavailable right now.
				</p>
			</Panel>
		);
	if (!data)
		return (
			<Panel title="Pipeline health" action={action} className={className}>
				<p className="text-xs text-muted-foreground">Loading…</p>
			</Panel>
		);

	const s = data.captures.byStatus;
	const day = (k: string) => s[k]?.last24h ?? 0;
	const week = (k: string) => s[k]?.last7d ?? 0;
	const total24 = Object.values(s).reduce((a, v) => a + v.last24h, 0);
	const problems24 = day("failed") + day("needs_review");
	const failing = data.parsers.filter((p) => p.failing);
	const outdated = data.outdated.reduce((a, r) => a + r.outdated, 0);
	const autoEligible = data.outdated.reduce((a, r) => a + r.autoEligible, 0);
	const exportsFailed = count(data.exports, "failed");
	const exportsStuck = data.exports.reduce((a, r) => a + r.stuck, 0);
	const exportsStale = count(data.exports, "stale");
	const exportsQueued = count(data.exports, "queued");
	const enrichPending =
		count(data.enrichment, "pending") + count(data.enrichment, "claimed");

	return (
		<Panel
			title="Pipeline health"
			action={action}
			className={className}
			bodyClassName="space-y-3"
		>
			<div className="grid grid-cols-2 gap-2 md:grid-cols-5">
				<StatTile
					label="Captures 24h"
					value={total24}
					hint={`${week("parsed")} parsed / 7d`}
				/>
				<StatTile
					label="Problems 24h"
					value={problems24}
					tone={problems24 > 0 ? "danger" : "success"}
					hint={`${week("failed")} failed, ${week("needs_review")} review / 7d`}
				/>
				<StatTile
					label="Older parser"
					value={outdated}
					tone={outdated > 0 ? "warning" : undefined}
					hint={
						autoEligible > 0
							? `${autoEligible} re-parse automatically`
							: "Up to date"
					}
				/>
				<StatTile
					label="Exports"
					value={exportsFailed + exportsStuck + exportsStale}
					tone={
						exportsFailed + exportsStuck + exportsStale > 0
							? "danger"
							: "success"
					}
					hint={`${exportsFailed} failed, ${exportsStale} stale, ${exportsQueued} queued`}
				/>
				<StatTile
					label="Missing details"
					value={enrichPending}
					hint={`${count(data.enrichment, "failed")} failed fetches`}
				/>
			</div>

			{count(data.enrichment, "failed") > 0 && (
				<Button disabled={retry.isPending} onClick={() => retry.mutate()}>
					{retry.isPending ? "Requeuing…" : "Retry failed fetches"}
				</Button>
			)}
			{failing.length > 0 && (
				<div className="space-y-1">
					<div className="label-caps">Failing parsers (7 days)</div>
					<ul className="space-y-0.5 text-xs">
						{failing.map((p) => (
							<li
								key={`${p.parserId}-${p.parserVersion}`}
								className="flex items-center gap-2"
							>
								<IconAlertTriangle className="size-3.5 text-red-500" />
								<span className="font-medium">{storeLabel(p.parserId)}</span>
								<span className="font-mono text-muted-foreground">
									v{p.parserVersion ?? "?"}
									{p.currentVersion !== null &&
										p.currentVersion !== p.parserVersion &&
										` (now v${p.currentVersion})`}
								</span>
								<Tag tone="danger">{p.failurePct}% failing</Tag>
								<span className="text-muted-foreground">
									{p.failed + p.needsReview} of {p.total}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			<UnsupportedOrders />

			{data.outdated.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 text-xs">
					<span className="text-muted-foreground">
						Parsed by an older version:
					</span>
					{data.outdated.map((r) => (
						<Tag key={r.parserId} tone="warning">
							{storeLabel(r.parserId)} {r.outdated}
						</Tag>
					))}
				</div>
			)}

			{data.ingressErrors.length > 0 && (
				<div className="space-y-1">
					<div className="label-caps">Ingress sources with errors</div>
					<ul className="space-y-0.5 text-xs">
						{data.ingressErrors.map((src) => (
							<li key={src.id} className="flex min-w-0 items-baseline gap-2">
								<Tag tone="danger">{src.kind.replace(/_/g, " ")}</Tag>
								<span className="shrink-0 font-medium">{src.name}</span>
								<span
									className="truncate text-muted-foreground"
									title={src.lastError ?? ""}
								>
									{src.lastError ?? "error"}
								</span>
								<span className="ml-auto shrink-0 text-muted-foreground">
									{formatRelative(src.lastRunAt)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			<div
				className={cn(
					"flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground",
				)}
			>
				{data.connections.error > 0 && (
					<span className="text-red-600 dark:text-red-400">
						{data.connections.error} connection(s) in error
					</span>
				)}
				{exportsStuck > 0 && (
					<span className="text-red-600 dark:text-red-400">
						{exportsStuck} export(s) stuck sending
					</span>
				)}
				{data.compaction.compacted > 0 && (
					<span>
						{data.compaction.compacted} old capture bodies archived (
						{formatBytes(data.compaction.bytes)})
					</span>
				)}
				<span>Checked {formatRelative(data.checkedAt)}</span>
			</div>
		</Panel>
	);
}
