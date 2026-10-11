/** Queued / uploaded captures with progress, server status and actions. */
import {
	IconAlertTriangle,
	IconCheck,
	IconClock,
	IconExternalLink,
	IconFileTypePdf,
	IconLoader2,
	IconPhoto,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type {
	CaptureQueue,
	QueueItem,
	QueueSnapshot,
} from "#/features/capture/queue";
import { cn } from "#/lib/utils";
import {
	type CaptureServerState,
	useCaptureStatus,
} from "./use-capture-status";

const touchButton =
	"inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium active:opacity-80 disabled:opacity-50 [&_svg]:size-5";

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function QueueList({
	queue,
	snapshot,
	online,
	waiting,
}: {
	queue: CaptureQueue | null;
	snapshot: QueueSnapshot;
	online: boolean;
	waiting: number;
}) {
	const status = useCaptureStatus(
		snapshot.items.flatMap((i) => (i.captureId ? [i.captureId] : [])),
	);
	const uploaded = snapshot.items.filter((i) => i.status === "uploaded").length;

	if (!snapshot.loaded)
		return (
			<div className="flex h-24 items-center justify-center text-muted-foreground">
				<IconLoader2 className="size-5 animate-spin" />
			</div>
		);
	if (!snapshot.items.length)
		return (
			<p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
				Nothing captured yet. Photos taken offline are kept on this device and
				uploaded automatically when you are back online.
			</p>
		);

	return (
		<section className="flex flex-col gap-2">
			<div className="flex min-h-11 items-center justify-between gap-2">
				<h2 className="label-caps">
					{waiting > 0
						? `${waiting} waiting${online ? "" : " · offline"}`
						: "Recent captures"}
				</h2>
				<div className="flex gap-2">
					{waiting > 0 && online && (
						<button
							type="button"
							disabled={snapshot.flushing}
							onClick={() => void queue?.flush(true)}
							className={cn(touchButton, "border-border bg-secondary")}
						>
							<IconRefresh
								className={cn(snapshot.flushing && "animate-spin")}
							/>
							Upload now
						</button>
					)}
					{uploaded > 0 && (
						<button
							type="button"
							onClick={() => void queue?.clearUploaded()}
							className={cn(
								touchButton,
								"border-transparent text-muted-foreground",
							)}
						>
							Clear done
						</button>
					)}
				</div>
			</div>
			<ul className="flex flex-col gap-2">
				{snapshot.items.map((item) => (
					<QueueRow
						key={item.id}
						item={item}
						progress={snapshot.progress[item.id]}
						server={item.captureId ? status.get(item.captureId) : undefined}
						onRetry={() => void queue?.retry(item.id)}
						onRemove={() => void queue?.remove(item.id)}
					/>
				))}
			</ul>
			<Link
				to="/app/import/documents"
				search={{ view: "review" }}
				className={cn(touchButton, "w-full border-border bg-card")}
			>
				Open review queue
				<IconExternalLink />
			</Link>
		</section>
	);
}

function QueueRow({
	item,
	progress,
	server,
	onRetry,
	onRemove,
}: {
	item: QueueItem;
	progress: number | undefined;
	server: CaptureServerState | undefined;
	onRetry: () => void;
	onRemove: () => void;
}) {
	const row = server && server.state !== "unknown" ? server.row : null;
	const name = row?.fileName ?? item.fileName;
	const extracted = [
		row?.merchantName ?? item.meta.merchantHint,
		row?.total ? `${row.total}${row.currency ? ` ${row.currency}` : ""}` : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<li className="flex gap-3 rounded-lg border border-border bg-card p-3">
			<div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
				{item.thumbnail ? (
					<img src={item.thumbnail} alt="" className="size-full object-cover" />
				) : item.contentType === "application/pdf" ? (
					<IconFileTypePdf className="size-6" />
				) : (
					<IconPhoto className="size-6" />
				)}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="truncate text-[15px] font-medium">{name}</div>
				<StatusLine item={item} progress={progress} server={server} />
				{extracted && (
					<div className="truncate text-[13px] text-muted-foreground">
						{extracted}
					</div>
				)}
				{item.status === "uploading" && (
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
						<div
							className="h-full bg-primary transition-[width]"
							style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
						/>
					</div>
				)}
				<div className="mt-1 flex flex-wrap gap-2">
					{item.captureId && server?.state === "filed" && server.row.orderId ? (
						<Link
							to="/app/orders/$orderId"
							params={{ orderId: server.row.orderId }}
							className={cn(touchButton, "border-border bg-secondary")}
						>
							Open order
						</Link>
					) : item.captureId ? (
						<Link
							to="/app/import/documents"
							search={{ view: "review", capture: item.captureId }}
							className={cn(
								touchButton,
								"border-primary/50 bg-primary/10 text-primary",
							)}
						>
							Review
						</Link>
					) : null}
					{(item.status === "failed" ||
						item.status === "rejected" ||
						item.status === "pending") &&
						item.blob && (
							<button
								type="button"
								onClick={onRetry}
								className={cn(touchButton, "border-border bg-secondary")}
							>
								<IconRefresh />
								Retry
							</button>
						)}
					{item.status !== "uploading" && (
						<button
							type="button"
							aria-label={`Remove ${name}`}
							onClick={() => {
								if (
									item.status === "uploaded" ||
									window.confirm("Discard this capture from the device?")
								)
									onRemove();
							}}
							className={cn(
								touchButton,
								"border-transparent text-muted-foreground",
							)}
						>
							<IconTrash />
						</button>
					)}
				</div>
			</div>
		</li>
	);
}

function StatusLine({
	item,
	progress,
	server,
}: {
	item: QueueItem;
	progress: number | undefined;
	server: CaptureServerState | undefined;
}) {
	const size = item.size ? formatBytes(item.size) : null;
	const shrunk =
		item.size && item.originalSize > item.size * 1.2
			? ` (from ${formatBytes(item.originalSize)})`
			: "";
	let icon = <IconClock />;
	let text: string;
	let tone = "text-muted-foreground";
	switch (item.status) {
		case "pending":
			text = "Waiting to upload";
			break;
		case "uploading":
			icon = <IconLoader2 className="animate-spin" />;
			text = `Uploading ${Math.round((progress ?? 0) * 100)}%`;
			tone = "text-primary";
			break;
		case "failed":
			icon = <IconAlertTriangle />;
			text = `Will retry — ${item.lastError ?? "upload failed"}`;
			tone = "text-amber-600 dark:text-amber-400";
			break;
		case "rejected":
			icon = <IconAlertTriangle />;
			text = item.lastError ?? "Rejected";
			tone = "text-red-600 dark:text-red-400";
			break;
		default: {
			icon = <IconCheck />;
			tone = "text-emerald-600 dark:text-emerald-400";
			const dup = item.duplicate ? " (already uploaded before)" : "";
			if (!server) text = `Uploaded${dup}`;
			else if (server.state === "processing") {
				icon = <IconLoader2 className="animate-spin" />;
				tone = "text-primary";
				text = "Uploaded · reading document…";
			} else if (server.state === "review") text = `Ready to review${dup}`;
			else if (server.state === "failed") {
				icon = <IconAlertTriangle />;
				tone = "text-amber-600 dark:text-amber-400";
				text = "Uploaded · extraction failed, review manually";
			} else if (server.state === "filed") text = "Filed to an order";
			else {
				tone = "text-muted-foreground";
				text = "Uploaded · ignored or no longer in the queue";
			}
		}
	}
	return (
		<div
			className={cn(
				"flex items-center gap-1.5 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0",
				tone,
			)}
		>
			{icon}
			<span className="truncate">
				{text}
				{size && item.status !== "uploaded" && (
					<span className="text-muted-foreground">
						{" "}
						· {size}
						{shrunk}
					</span>
				)}
			</span>
		</div>
	);
}
