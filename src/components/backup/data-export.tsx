/**
 * "Export everything" panel: queue a full ZIP archive (all tables as JSON +
 * CSV plus every stored document), then download it. Mount in Settings:
 * <DataExport />.
 */
import {
	IconArchive,
	IconDownload,
	IconLoader2,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatBytes, formatRelative } from "#/components/app/format";
import { Button, EmptyState, Panel, Tag } from "#/components/app/primitives";
import {
	deleteExportArchive,
	exportArchiveDownloadPath,
	listExportArchives,
	requestExportArchive,
} from "#/features/backup/backup.functions";

const archivesKey = ["backup", "archives"] as const;

const STATUS_TONES = {
	queued: "primary",
	running: "primary",
	ready: "success",
	failed: "danger",
	expired: "neutral",
} as const;

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function DataExport() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: archivesKey,
		queryFn: () => listExportArchives(),
		refetchInterval: (q) =>
			q.state.data?.some((a) => a.status === "queued" || a.status === "running")
				? 3000
				: false,
	});
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: archivesKey });
	const request = useMutation({
		mutationFn: () => requestExportArchive(),
		onSuccess: (archive) => {
			if (archive.status === "failed")
				toast.error(archive.error ?? "Export could not be queued");
			else toast.success("Export started. This can take a few minutes.");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: (archiveId: string) =>
			deleteExportArchive({ data: { archiveId } }),
		onSuccess: () => void invalidate(),
		onError: (error) => toast.error(errorMessage(error)),
	});
	const archives = query.data ?? [];
	const busy = archives.some(
		(a) => a.status === "queued" || a.status === "running",
	);

	return (
		<Panel
			title="Export everything"
			action={
				<Button
					variant="primary"
					disabled={request.isPending || busy}
					onClick={() => request.mutate()}
				>
					{busy ? <IconLoader2 className="animate-spin" /> : <IconArchive />}
					{busy ? "Exporting…" : "Create archive"}
				</Button>
			}
			bodyClassName="flex flex-col gap-3 p-3"
		>
			<p className="text-xs text-muted-foreground">
				One ZIP with every order, item, allocation, claim, entity, category,
				payment method, rule and capture (metadata) as JSON and CSV, plus all
				stored invoices and documents. Archives are kept for 7 days. Connector
				secrets and raw capture snapshots are not included; for full disaster
				recovery use the operator backups in docs/BACKUP.md.
			</p>
			{query.isLoading ? (
				<div className="text-xs text-muted-foreground">Loading…</div>
			) : archives.length === 0 ? (
				<EmptyState
					icon={<IconArchive className="size-5" />}
					title="No archives yet"
					className="py-6"
				/>
			) : (
				<ul className="flex flex-col divide-y divide-border text-xs">
					{archives.map((archive) => (
						<li
							key={archive.id}
							className="flex flex-wrap items-center gap-2 py-1.5"
						>
							<Tag tone={STATUS_TONES[archive.status]}>{archive.status}</Tag>
							<span className="font-mono text-muted-foreground">
								{formatRelative(archive.createdAt)}
							</span>
							{archive.status === "ready" && (
								<span className="font-mono text-muted-foreground">
									{formatBytes(archive.sizeBytes ?? 0)} ·{" "}
									{archive.documentCount} documents
									{(archive.summary?.skippedDocuments ?? 0) > 0
										? ` · ${archive.summary?.skippedDocuments} skipped (see manifest)`
										: ""}
								</span>
							)}
							{archive.status === "failed" && archive.error && (
								<span className="min-w-0 flex-1 truncate text-red-600 dark:text-red-400">
									{archive.error}
								</span>
							)}
							<span className="ml-auto flex items-center gap-1">
								{archive.status === "ready" && (
									<a
										href={exportArchiveDownloadPath(archive.id)}
										className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-border bg-secondary px-2 hover:bg-accent [&_svg]:size-3.5"
									>
										<IconDownload />
										Download
									</a>
								)}
								{archive.status !== "running" &&
									archive.status !== "queued" && (
										<Button
											size="xs"
											variant="ghost"
											aria-label="Delete archive"
											disabled={remove.isPending}
											onClick={() => remove.mutate(archive.id)}
										>
											<IconTrash />
										</Button>
									)}
							</span>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}
