import {
	IconAlertTriangle,
	IconChevronLeft,
	IconChevronRight,
	IconRefresh,
	IconStack2,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
	CAPTURE_STATUS_TONES,
	formatBytes,
	formatRelative,
	STORE_META,
} from "#/components/app/format";
import {
	Button,
	EmptyState,
	PageHeader,
	Select,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { PipelineHealth } from "#/components/ops/pipeline-health";
import { ledgerKeys, useInvalidateLedger } from "#/features/ledger/hooks";
import { listCaptures } from "#/features/ledger/ledger.functions";
import {
	getCaptureFacets,
	reprocessFailedCaptures,
} from "#/features/ledger/review-ui.functions";
import { cn } from "#/lib/utils";
import type { StoreId } from "#/shared/capture";
import { CaptureDetailDrawer } from "./capture-detail";
import { errorMessage } from "./drawer";

export const CAPTURE_STATUSES = [
	"pending",
	"parsed",
	"no_orders",
	"needs_review",
	"failed",
	"ignored",
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export type CapturesPageSearch = {
	status?: CaptureStatus;
	source?: StoreId;
	capture?: string;
	page?: number;
};

const PAGE_SIZE = 100;
const POLL_MS = 10_000;

export function statusLabel(status: string) {
	return status.replace(/_/g, " ");
}

export function CapturesPage({
	search,
	onSearch,
}: {
	search: CapturesPageSearch;
	onSearch: (next: Partial<CapturesPageSearch>) => void;
}) {
	const invalidate = useInvalidateLedger();
	const page = search.page ?? 0;
	const filters = {
		status: search.status,
		source: search.source,
		limit: PAGE_SIZE,
		offset: page * PAGE_SIZE,
	};
	const list = useQuery({
		queryKey: ledgerKeys.captures(filters),
		queryFn: () => listCaptures({ data: filters }),
		refetchInterval: POLL_MS,
		placeholderData: (previous) => previous,
	});
	const facets = useQuery({
		queryKey: ledgerKeys.captures("facets"),
		queryFn: () => getCaptureFacets(),
		refetchInterval: POLL_MS,
	});
	const statusCount = new Map(
		(facets.data?.byStatus ?? []).map((row) => [row.status, row.n]),
	);
	const failedCount = statusCount.get("failed") ?? 0;

	const reprocessFailed = useMutation({
		mutationFn: () =>
			reprocessFailedCaptures({ data: { source: search.source } }),
		onSuccess: (result) => {
			toast.success(
				result.queued
					? `Queued ${result.queued} failed capture${result.queued === 1 ? "" : "s"}`
					: "No failed captures to re-process",
			);
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const rows = list.data?.captures ?? [];
	const total = list.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

	return (
		<div className="flex min-h-full flex-col">
			<PageHeader
				title="Captures"
				description="Ingest log: every raw payload the extension sent, how it parsed, and what it produced. Polls every 10s."
				actions={
					<>
						<Button
							variant="ghost"
							onClick={() => void list.refetch()}
							aria-label="Refresh captures"
						>
							<IconRefresh className={list.isFetching ? "animate-spin" : ""} />
							Refresh
						</Button>
						<Button
							variant="danger"
							disabled={failedCount === 0 || reprocessFailed.isPending}
							onClick={() => reprocessFailed.mutate()}
						>
							<IconRefresh />
							Re-process all failed
							{failedCount > 0 && (
								<span className="font-mono">({failedCount})</span>
							)}
						</Button>
					</>
				}
			/>
			<div className="border-b border-border p-3">
				<PipelineHealth />
			</div>

			<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
				<fieldset className="flex flex-wrap items-center gap-1">
					<legend className="sr-only">Filter by status</legend>
					<StatusChip
						label="All"
						active={!search.status}
						count={(facets.data?.byStatus ?? []).reduce(
							(sum, row) => sum + row.n,
							0,
						)}
						onClick={() => onSearch({ status: undefined, page: undefined })}
					/>
					{CAPTURE_STATUSES.map((status) => (
						<StatusChip
							key={status}
							label={statusLabel(status)}
							active={search.status === status}
							count={statusCount.get(status) ?? 0}
							tone={CAPTURE_STATUS_TONES[status]}
							onClick={() =>
								onSearch({
									status: search.status === status ? undefined : status,
									page: undefined,
								})
							}
						/>
					))}
				</fieldset>
				{/* biome-ignore lint/a11y/noLabelWithoutControl: wraps its Select */}
				<label className="ml-auto flex items-center gap-1.5">
					<span className="label-caps">Source</span>
					<Select
						className="w-36"
						value={search.source ?? ""}
						onChange={(event) =>
							onSearch({
								source: (event.target.value || undefined) as
									| StoreId
									| undefined,
								page: undefined,
							})
						}
					>
						<option value="">All stores</option>
						{(Object.keys(STORE_META) as StoreId[]).map((id) => {
							const n = facets.data?.bySource.find(
								(row) => row.source === id,
							)?.n;
							return (
								<option key={id} value={id}>
									{STORE_META[id].label}
									{n ? ` (${n})` : ""}
								</option>
							);
						})}
					</Select>
				</label>
			</div>

			<div className="flex-1 p-4">
				{list.isError ? (
					<EmptyState
						icon={<IconAlertTriangle className="size-6" />}
						title="Could not load captures"
					>
						{errorMessage(list.error)}
					</EmptyState>
				) : list.isPending ? (
					<div className="text-xs text-muted-foreground">Loading captures…</div>
				) : rows.length === 0 ? (
					<EmptyState
						icon={<IconStack2 className="size-6" />}
						title="No captures"
					>
						{search.status || search.source
							? "Nothing matches these filters."
							: "Install the extension and browse your order pages; captures will appear here."}
					</EmptyState>
				) : (
					<div className="overflow-x-auto rounded border border-border bg-card">
						<table className="w-full min-w-[720px] text-xs">
							<caption className="sr-only">
								Captures, newest first. Select a row to inspect.
							</caption>
							<thead className="border-b border-border bg-muted/40">
								<tr className="h-7 text-left">
									<Th>Received</Th>
									<Th>Store</Th>
									<Th className="hidden lg:table-cell">Kind</Th>
									<Th className="hidden xl:table-cell">Trigger</Th>
									<Th className="hidden lg:table-cell">Page type</Th>
									<Th>Page</Th>
									<Th>Status</Th>
									<Th className="hidden md:table-cell">Parser</Th>
									<Th className="text-right">Orders</Th>
									<Th className="hidden md:table-cell text-right">Size</Th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<tr
										key={row.id}
										onClick={() => onSearch({ capture: row.id })}
										className={cn(
											"h-7 cursor-pointer border-b border-border last:border-0 hover:bg-accent/50",
											search.capture === row.id && "bg-accent/60",
										)}
									>
										<Td
											className="whitespace-nowrap font-mono tabular-nums text-muted-foreground"
											title={new Date(row.receivedAt).toLocaleString()}
										>
											{formatRelative(row.receivedAt)}
										</Td>
										<Td className="whitespace-nowrap">
											<StoreMark source={row.source} />
										</Td>
										<Td className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground lg:table-cell">
											{row.kind}
										</Td>
										<Td className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground xl:table-cell">
											{row.trigger}
										</Td>
										<Td className="hidden whitespace-nowrap font-mono text-[11px] lg:table-cell">
											{row.pageType}
										</Td>
										<Td className="max-w-[22rem]">
											<Link
												to="/app/captures"
												search={{ ...search, capture: row.id }}
												className="block truncate hover:underline"
												onClick={(event) => event.stopPropagation()}
											>
												{row.pageTitle || row.pageUrl}
											</Link>
											<div className="truncate font-mono text-[10px] text-muted-foreground">
												{row.pageUrl}
											</div>
											{row.error && (
												<div
													className="truncate font-mono text-[10px] text-red-600 dark:text-red-400"
													title={row.error}
												>
													{row.error}
												</div>
											)}
										</Td>
										<Td className="whitespace-nowrap">
											<Tag tone={CAPTURE_STATUS_TONES[row.status] ?? "neutral"}>
												{statusLabel(row.status)}
											</Tag>
										</Td>
										<Td className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground md:table-cell">
											{row.parserId
												? `${row.parserId}@${row.parserVersion ?? "?"}`
												: "—"}
										</Td>
										<Td className="text-right font-mono tabular-nums">
											{row.ordersFound}
										</Td>
										<Td className="hidden whitespace-nowrap text-right font-mono tabular-nums text-muted-foreground md:table-cell">
											{formatBytes(row.sizeBytes)}
										</Td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{total > PAGE_SIZE && (
					<nav
						aria-label="Pagination"
						className="mt-3 flex items-center justify-end gap-2 text-xs"
					>
						<span className="font-mono tabular-nums text-muted-foreground">
							{page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)}{" "}
							of {total}
						</span>
						<Button
							aria-label="Previous page"
							disabled={page === 0}
							onClick={() => onSearch({ page: page - 1 || undefined })}
						>
							<IconChevronLeft />
						</Button>
						<Button
							aria-label="Next page"
							disabled={page + 1 >= pageCount}
							onClick={() => onSearch({ page: page + 1 })}
						>
							<IconChevronRight />
						</Button>
					</nav>
				)}
			</div>

			<CaptureDetailDrawer
				captureId={search.capture ?? null}
				onClose={() => onSearch({ capture: undefined })}
			/>
		</div>
	);
}

function StatusChip({
	label,
	count,
	active,
	tone,
	onClick,
}: {
	label: string;
	count: number;
	active: boolean;
	tone?: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={
				"inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-[11px] capitalize transition-colors " +
				(active
					? "border-primary bg-primary/12 text-foreground"
					: "border-border text-muted-foreground hover:bg-accent hover:text-foreground")
			}
		>
			{label}
			<span
				className={
					"font-mono tabular-nums " +
					(tone === "danger" && count > 0
						? "text-red-600 dark:text-red-400"
						: tone === "warning" && count > 0
							? "text-amber-600 dark:text-amber-400"
							: "")
				}
			>
				{count}
			</span>
		</button>
	);
}

function Th({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<th
			scope="col"
			className={`label-caps px-2 font-semibold ${className ?? ""}`}
		>
			{children}
		</th>
	);
}

function Td({
	children,
	className,
	title,
}: {
	children: ReactNode;
	className?: string;
	title?: string;
}) {
	return (
		<td className={`px-2 py-1 align-middle ${className ?? ""}`} title={title}>
			{children}
		</td>
	);
}
