/**
 * Import → Documents: upload invoices/receipts, review queue of document
 * captures (uploads, email attachments, Paperless) without an order, and
 * the assisted review workspace.
 */
import { IconFileText, IconLoader2, IconPhoto } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	CAPTURE_STATUS_TONES,
	formatRelative,
	storeLabel,
} from "#/components/app/format";
import {
	EmptyState,
	Money,
	PageHeader,
	Tag,
} from "#/components/app/primitives";
import { decimalToMinor } from "#/features/ingress/documents/fields";
import type { QueueView } from "#/features/ingress/documents/inputs";
import {
	getDocumentReview,
	listDocumentQueue,
} from "#/features/ingress/documents/review-ui.functions";
import type {
	DocumentQueueRow,
	DocumentReview,
} from "#/features/ingress/documents/review-ui.server";
import { useLedgerLive } from "#/features/ledger/hooks";
import { cn } from "#/lib/utils";
import { ReviewWorkspace } from "./review-workspace";
import { UploadZone } from "./upload-zone";

export const documentKeys = {
	queue: (view: QueueView) => ["ledger", "documents", "queue", view] as const,
	review: (id: string) => ["ledger", "documents", "review", id] as const,
};

const VIEWS: Array<{ id: QueueView; label: string }> = [
	{ id: "review", label: "To review" },
	{ id: "done", label: "Done" },
	{ id: "ignored", label: "Ignored" },
];

export function DocumentsPage({
	view,
	captureId,
	onNavigate,
}: {
	view: QueueView;
	captureId: string | undefined;
	onNavigate: (next: {
		view?: QueueView;
		capture?: string | undefined;
	}) => void;
}) {
	useLedgerLive();
	const client = useQueryClient();
	// Bumped after "Analyze"/"Re-scan" so the form re-reads the new extraction.
	const [analysisNonce, setAnalysisNonce] = useState(0);
	const queue = useQuery({
		queryKey: documentKeys.queue(view),
		queryFn: () => listDocumentQueue({ data: { view, limit: 100 } }),
		refetchInterval: (query) =>
			query.state.data?.rows.some((r) => r.status === "pending")
				? 2500
				: 30_000,
	});
	const rows = queue.data?.rows ?? [];
	const lastRows = useRef<DocumentQueueRow[]>([]);
	if (rows.length) lastRows.current = rows;

	// Select the first queue item when nothing (valid) is selected.
	useEffect(() => {
		if (!queue.data) return;
		if (captureId) return;
		const first = queue.data.rows[0];
		if (first) onNavigate({ capture: first.id });
	}, [queue.data, captureId, onNavigate]);

	const review = useQuery({
		queryKey: documentKeys.review(captureId ?? "none"),
		queryFn: () => getDocumentReview({ data: { captureId: captureId ?? "" } }),
		enabled: !!captureId,
		refetchInterval: (query) =>
			query.state.data?.capture.status === "pending" ? 2500 : false,
	});

	const selectNext = () => {
		const list = lastRows.current;
		const index = list.findIndex((r) => r.id === captureId);
		const next = list[index + 1] ?? list[index - 1];
		onNavigate({
			capture: next && next.id !== captureId ? next.id : undefined,
		});
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<PageHeader
				title="Documents"
				description="Upload invoices and receipts (PDF or photo). Text is read with OCR; confirm the fields and create orders."
			/>
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<aside className="flex w-full shrink-0 flex-col border-b border-border md:w-72 md:border-r md:border-b-0">
					<div className="border-b border-border p-2">
						<UploadZone
							onUploaded={(results) => {
								void client.invalidateQueries({
									queryKey: ["ledger", "documents"],
								});
								const first = results.find((r) => r.ok && r.captureId);
								if (first?.captureId)
									onNavigate({ view: "review", capture: first.captureId });
							}}
						/>
					</div>
					<div className="flex border-b border-border">
						{VIEWS.map((v) => (
							<button
								key={v.id}
								type="button"
								onClick={() => onNavigate({ view: v.id, capture: undefined })}
								className={cn(
									"flex flex-1 items-center justify-center gap-1 border-b-2 py-1.5 text-[11px]",
									view === v.id
										? "border-primary text-foreground"
										: "border-transparent text-muted-foreground hover:text-foreground",
								)}
							>
								{v.label}
								<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
									{queue.data?.counts[v.id] ?? "–"}
								</span>
							</button>
						))}
					</div>
					<div className="max-h-64 min-h-0 flex-1 overflow-y-auto md:max-h-none">
						{queue.isLoading && (
							<div className="flex justify-center py-6 text-muted-foreground">
								<IconLoader2 className="size-4 animate-spin" />
							</div>
						)}
						{queue.data && rows.length === 0 && (
							<div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
								{view === "review" ? "Nothing to review." : "Empty."}
							</div>
						)}
						{rows.map((row) => (
							<QueueRow
								key={row.id}
								row={row}
								active={row.id === captureId}
								onClick={() => onNavigate({ capture: row.id })}
							/>
						))}
					</div>
				</aside>
				<main className="flex min-h-0 min-w-0 flex-1 flex-col">
					{!captureId ? (
						<EmptyState
							className="m-4"
							icon={<IconFileText className="size-6" />}
							title="No document selected"
						>
							Upload a PDF or a photo of a receipt. Email attachments and
							Paperless documents that could not be matched automatically also
							show up here.
						</EmptyState>
					) : review.isLoading ? (
						<div className="flex flex-1 items-center justify-center text-muted-foreground">
							<IconLoader2 className="size-5 animate-spin" />
						</div>
					) : review.error ? (
						<EmptyState className="m-4" title="Could not load this document">
							{review.error instanceof Error
								? review.error.message
								: "Unknown error"}
						</EmptyState>
					) : review.data ? (
						<ReviewWorkspace
							// Reset the form when the capture or its extraction changes.
							key={`${analysisNonce}:${review.data.capture.id}:${review.data.extraction ? "x" : "-"}:${review.data.layout?.ocrSource ?? ""}:${review.data.layout?.pages.length ?? 0}`}
							review={review.data}
							onResolved={selectNext}
							onAnalyzed={(next: DocumentReview) => {
								client.setQueryData(documentKeys.review(next.capture.id), next);
								setAnalysisNonce((n) => n + 1);
							}}
						/>
					) : null}
				</main>
			</div>
		</div>
	);
}

function QueueRow({
	row,
	active,
	onClick,
}: {
	row: DocumentQueueRow;
	active: boolean;
	onClick: () => void;
}) {
	const isImage = row.contentType?.startsWith("image/");
	const totalMinor = decimalToMinor(
		row.total ?? undefined,
		row.currency ?? undefined,
	);
	const status =
		row.status === "pending"
			? "processing"
			: row.orderId
				? "linked"
				: row.status === "ignored"
					? "ignored"
					: "review";
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left hover:bg-accent",
				active && "bg-accent",
			)}
		>
			<div className="flex w-full items-center gap-1.5">
				{isImage ? (
					<IconPhoto className="size-3.5 shrink-0 text-muted-foreground" />
				) : (
					<IconFileText className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="min-w-0 flex-1 truncate text-xs font-medium">
					{row.merchantName || row.fileName || row.title || "Document"}
				</span>
				{totalMinor !== undefined && (
					<Money
						minor={totalMinor}
						currency={row.currency ?? "USD"}
						className="text-[11px]"
					/>
				)}
			</div>
			<div className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
				<span className="min-w-0 flex-1 truncate">
					{row.externalOrderId ? `#${row.externalOrderId} · ` : ""}
					{row.fileName ?? row.title}
				</span>
				<span className="shrink-0">{formatRelative(row.receivedAt)}</span>
			</div>
			<div className="flex items-center gap-1">
				<Tag tone="neutral">{row.channel}</Tag>
				{row.source !== "generic" && (
					<Tag tone="info">{storeLabel(row.source)}</Tag>
				)}
				<Tag
					tone={
						status === "processing"
							? "primary"
							: status === "linked"
								? "success"
								: status === "ignored"
									? "neutral"
									: (CAPTURE_STATUS_TONES.needs_review ?? "warning")
					}
				>
					{status === "processing" && (
						<IconLoader2 className="size-2.5 animate-spin" />
					)}
					{status}
				</Tag>
			</div>
		</button>
	);
}
