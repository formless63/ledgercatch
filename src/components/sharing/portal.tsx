/**
 * Read-only grantee portal (/share). Every query goes through grantee-scoped
 * server functions that resolve an active share for (viewer, entity).
 */
import {
	IconDownload,
	IconExternalLink,
	IconFileInvoice,
	IconLock,
	IconShare,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	formatBytes,
	formatDate,
	ORDER_STATUS_TONES,
} from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Field,
	Input,
	Money,
	PageHeader,
	Panel,
	ReimbursementTag,
	StatTile,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import {
	acceptEntityShare,
	exportSharedCsv,
	getSharedOrder,
	getSharedSummary,
	listMyShares,
	listSharedClaims,
	listSharedOrders,
} from "#/features/sharing/sharing.functions";
import { cn } from "#/lib/utils";

export const shareKeys = {
	mine: ["share", "mine"] as const,
	summary: (entityId: string, range: unknown) =>
		["share", entityId, "summary", range] as const,
	orders: (entityId: string, filters: unknown) =>
		["share", entityId, "orders", filters] as const,
	order: (entityId: string, orderId: string) =>
		["share", entityId, "order", orderId] as const,
	claims: (entityId: string) => ["share", entityId, "claims"] as const,
};

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function sharedDocumentHref(
	entityId: string,
	documentId: string,
	download = false,
) {
	return `/share/${entityId}/files/${documentId}${download ? "?download" : ""}`;
}

export function useMyShares() {
	return useQuery({ queryKey: shareKeys.mine, queryFn: () => listMyShares() });
}

/* ───────────────────────── home / accept ───────────────────────── */

export function SharedHome() {
	const shares = useMyShares();
	if (shares.isLoading)
		return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;
	const rows = shares.data ?? [];
	return (
		<div>
			<PageHeader
				title="Shared with you"
				description="Read-only books other people have shared with your account."
			/>
			<div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
				{rows.length === 0 ? (
					<EmptyState
						className="sm:col-span-2 lg:col-span-3"
						icon={<IconShare className="size-5" />}
						title="Nothing shared yet"
					>
						Open the invitation link from your email while signed in with the
						invited address.
					</EmptyState>
				) : (
					rows.map((share) => (
						<Link
							key={share.shareId}
							to="/share/$entityId"
							params={{ entityId: share.entityId }}
							className="rounded border border-border bg-card p-3 hover:bg-accent"
						>
							<EntityChip entity={{ ...share, id: share.entityId }} />
							<div className="mt-2 text-xs text-muted-foreground">
								Shared by {share.ownerName || share.ownerEmail}
							</div>
						</Link>
					))
				)}
			</div>
		</div>
	);
}

export function AcceptInvite({ token }: { token: string | undefined }) {
	const navigate = useNavigate();
	const started = useRef(false);
	const accept = useMutation({
		mutationFn: (value: string) =>
			acceptEntityShare({ data: { token: value } }),
		onSuccess: (result) => {
			toast.success("Invitation accepted");
			void navigate({
				to: "/share/$entityId",
				params: { entityId: result.entityId },
				replace: true,
			});
		},
	});
	useEffect(() => {
		if (token && !started.current) {
			started.current = true;
			accept.mutate(token);
		}
	}, [token, accept]);
	return (
		<div className="mx-auto max-w-md p-6">
			<Panel title="Invitation">
				{!token ? (
					<p className="text-xs text-muted-foreground">
						This link is missing its token. Open the link from the invitation
						email again.
					</p>
				) : accept.isError ? (
					<div className="flex flex-col gap-2 text-xs">
						<p className="text-red-600 dark:text-red-400">
							{errorMessage(accept.error)}
						</p>
						<Link to="/share" className="text-primary hover:underline">
							Go to shared books
						</Link>
					</div>
				) : (
					<p className="text-xs text-muted-foreground">Accepting…</p>
				)}
			</Panel>
		</div>
	);
}

/* ───────────────────────── entity portal ───────────────────────── */

export function SharedEntityHeader({ entityId }: { entityId: string }) {
	const shares = useMyShares();
	const share = shares.data?.find((s) => s.entityId === entityId);
	const tab =
		"flex h-8 items-center border-b-2 border-transparent px-2 text-xs text-muted-foreground hover:text-foreground";
	const active = { className: "!border-primary !text-foreground font-medium" };
	return (
		<div className="border-b border-border">
			<div className="flex flex-wrap items-center gap-3 px-4 pt-3">
				{share ? (
					<EntityChip entity={{ ...share, id: share.entityId }} />
				) : (
					<span className="h-[18px]" />
				)}
				<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
					<IconLock className="size-3" />
					Read-only
					{share ? ` · shared by ${share.ownerName || share.ownerEmail}` : ""}
				</span>
			</div>
			<nav className="flex gap-1 px-3">
				<Link
					to="/share/$entityId"
					params={{ entityId }}
					activeOptions={{ exact: true }}
					className={tab}
					activeProps={active}
				>
					Expenses
				</Link>
				<Link
					to="/share/$entityId/claims"
					params={{ entityId }}
					className={tab}
					activeProps={active}
				>
					Claims
				</Link>
			</nav>
		</div>
	);
}

export type SharedFilters = {
	from?: string;
	to?: string;
	q?: string;
	page?: number;
};

const PAGE_SIZE = 100;

function downloadText(fileName: string, text: string, type = "text/csv") {
	const blob = new Blob([text], { type: `${type};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SharedExpenses({
	entityId,
	filters,
	onFiltersChange,
}: {
	entityId: string;
	filters: SharedFilters;
	onFiltersChange: (next: SharedFilters) => void;
}) {
	const range = { from: filters.from, to: filters.to };
	const page = filters.page ?? 0;
	const summary = useQuery({
		queryKey: shareKeys.summary(entityId, range),
		queryFn: () => getSharedSummary({ data: { entityId, ...range } }),
	});
	const orders = useQuery({
		queryKey: shareKeys.orders(entityId, filters),
		queryFn: () =>
			listSharedOrders({
				data: {
					entityId,
					...range,
					q: filters.q || undefined,
					limit: PAGE_SIZE,
					offset: page * PAGE_SIZE,
				},
			}),
	});
	const [q, setQ] = useState(filters.q ?? "");
	const csv = useMutation({
		mutationFn: () =>
			exportSharedCsv({
				data: { entityId, ...range, q: filters.q || undefined },
			}),
		onSuccess: (result) => downloadText(result.fileName, result.csv),
		onError: (error) => toast.error(errorMessage(error)),
	});

	if (summary.isError)
		return (
			<div className="p-4">
				<EmptyState icon={<IconLock className="size-5" />} title="No access">
					{errorMessage(summary.error)}
				</EmptyState>
			</div>
		);

	const data = summary.data;
	const total = orders.data?.total ?? 0;
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-end gap-2">
				<Field label="From">
					<Input
						type="date"
						className="w-36"
						value={filters.from ?? ""}
						onChange={(e) =>
							onFiltersChange({
								...filters,
								from: e.target.value || undefined,
								page: 0,
							})
						}
					/>
				</Field>
				<Field label="To">
					<Input
						type="date"
						className="w-36"
						value={filters.to ?? ""}
						onChange={(e) =>
							onFiltersChange({
								...filters,
								to: e.target.value || undefined,
								page: 0,
							})
						}
					/>
				</Field>
				<form
					className="flex min-w-48 flex-1 flex-col gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						onFiltersChange({ ...filters, q: q.trim() || undefined, page: 0 });
					}}
				>
					<span className="label-caps">Search</span>
					<Input
						value={q}
						placeholder="Store, merchant or order reference"
						onChange={(e) => setQ(e.target.value)}
					/>
				</form>
				<Button
					variant="primary"
					size="md"
					disabled={csv.isPending}
					onClick={() => csv.mutate()}
				>
					<IconDownload />
					Export CSV
				</Button>
			</div>

			<div className="grid gap-2 sm:grid-cols-3">
				<StatTile
					label="Total allocated"
					value={
						data?.totals.length ? (
							<span className="flex flex-col">
								{data.totals.map((t) => (
									<Money
										key={t.currency}
										minor={t.totalMinor}
										currency={t.currency}
									/>
								))}
							</span>
						) : (
							"—"
						)
					}
				/>
				<StatTile label="Orders" value={data?.orderCount ?? "—"} />
				<StatTile
					label="Reimbursement"
					value={
						data?.reimbursement.length ? (
							<span className="flex flex-col gap-0.5 text-xs font-normal">
								{data.reimbursement.map((r) => (
									<span
										key={`${r.status}-${r.currency}`}
										className="flex items-center gap-2"
									>
										<ReimbursementTag status={r.status} />
										<Money minor={r.totalMinor} currency={r.currency} />
									</span>
								))}
							</span>
						) : (
							"—"
						)
					}
				/>
			</div>

			<div className="grid gap-3 lg:grid-cols-[16rem_minmax(0,1fr)]">
				<Panel title="Monthly totals" bodyClassName="p-0">
					<table className="w-full text-xs">
						<tbody>
							{(data?.months ?? []).map((m) => (
								<tr
									key={`${m.month}-${m.currency}`}
									className="h-7 border-b border-border last:border-0"
								>
									<td className="px-3 font-mono">{m.month}</td>
									<td className="px-1 text-right font-mono text-muted-foreground">
										{m.count}
									</td>
									<td className="px-3 text-right">
										<Money minor={m.totalMinor} currency={m.currency} />
									</td>
								</tr>
							))}
							{data && data.months.length === 0 && (
								<tr>
									<td className="px-3 py-3 text-muted-foreground">
										No expenses in this range.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</Panel>

				<Panel
					title={`Expenses · ${total}`}
					bodyClassName="p-0"
					action={
						total > PAGE_SIZE ? (
							<div className="flex items-center gap-1 font-mono text-[11px]">
								<Button
									size="xs"
									variant="ghost"
									disabled={page === 0}
									onClick={() =>
										onFiltersChange({ ...filters, page: page - 1 })
									}
								>
									Prev
								</Button>
								<span>
									{page + 1}/{Math.ceil(total / PAGE_SIZE)}
								</span>
								<Button
									size="xs"
									variant="ghost"
									disabled={(page + 1) * PAGE_SIZE >= total}
									onClick={() =>
										onFiltersChange({ ...filters, page: page + 1 })
									}
								>
									Next
								</Button>
							</div>
						) : null
					}
				>
					<div className="overflow-x-auto">
						<table className="w-full text-xs">
							<thead>
								<tr className="label-caps h-7 border-b border-border text-left">
									<th className="px-3 font-normal">Date</th>
									<th className="px-2 font-normal">Store</th>
									<th className="px-2 font-normal">Order</th>
									<th className="px-2 font-normal">Category</th>
									<th className="px-2 text-right font-normal">Amount</th>
									<th className="px-2 font-normal">Reimb.</th>
									<th className="px-3 font-normal">Inv.</th>
								</tr>
							</thead>
							<tbody>
								{(orders.data?.rows ?? []).map((row) => (
									<tr
										key={row.allocationId}
										className="h-7 border-b border-border last:border-0 hover:bg-accent/50"
									>
										<td className="px-3 font-mono">
											{formatDate(row.orderDate)}
										</td>
										<td className="max-w-40 truncate px-2">
											<StoreMark source={row.source} />
										</td>
										<td className="px-2">
											<Link
												to="/share/$entityId/orders/$orderId"
												params={{ entityId, orderId: row.orderId }}
												className="font-mono text-primary hover:underline"
											>
												{row.externalOrderId}
											</Link>
											{row.merchantName && (
												<span className="ml-1.5 text-muted-foreground">
													{row.merchantName}
												</span>
											)}
											{row.sharedOrder && (
												<Tag tone="info" className="ml-1.5">
													shared order
												</Tag>
											)}
										</td>
										<td className="truncate px-2 text-muted-foreground">
											{row.categoryCode ? (
												<span className="font-mono">{row.categoryCode} </span>
											) : null}
											{row.categoryName ?? "—"}
										</td>
										<td className="px-2 text-right">
											<Money minor={row.amountMinor} currency={row.currency} />
										</td>
										<td className="px-2">
											{row.reimbursementStatus !== "none" && (
												<ReimbursementTag status={row.reimbursementStatus} />
											)}
										</td>
										<td className="px-3">
											{row.hasInvoice ? (
												<IconFileInvoice className="size-3.5 text-emerald-500" />
											) : (
												<span className="text-red-500">—</span>
											)}
										</td>
									</tr>
								))}
								{orders.data && orders.data.rows.length === 0 && (
									<tr>
										<td colSpan={7} className="px-3 py-4 text-muted-foreground">
											No expenses match.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</Panel>
			</div>
		</div>
	);
}

export function SharedOrderDetailView({
	entityId,
	orderId,
}: {
	entityId: string;
	orderId: string;
}) {
	const query = useQuery({
		queryKey: shareKeys.order(entityId, orderId),
		queryFn: () => getSharedOrder({ data: { entityId, orderId } }),
	});
	if (query.isLoading)
		return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;
	if (query.isError || !query.data)
		return (
			<div className="p-4">
				<EmptyState title="Order not available">
					{errorMessage(query.error)}
				</EmptyState>
			</div>
		);
	const { order, allocation, items, documents, sharedOrder } = query.data;
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center gap-2">
				<Link
					to="/share/$entityId"
					params={{ entityId }}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					← Expenses
				</Link>
				<h1 className="font-mono text-sm font-semibold">
					{order.externalOrderId}
				</h1>
				<StoreMark source={order.source} className="text-xs" />
				<Tag tone={ORDER_STATUS_TONES[order.status] ?? "neutral"}>
					{order.status}
				</Tag>
				{order.orderUrl && (
					<a
						href={order.orderUrl}
						target="_blank"
						rel="noreferrer noopener"
						className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
					>
						<IconExternalLink className="size-3" />
						Store page
					</a>
				)}
			</div>
			{sharedOrder && (
				<div className="rounded-sm border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5 text-[11px] text-cyan-700 dark:text-cyan-400">
					Shared order: part of this order is allocated to another entity. Only
					this entity&apos;s share and items are shown; the attached invoice
					covers the whole order.
				</div>
			)}
			<div className="grid gap-2 sm:grid-cols-4">
				<StatTile
					label="Allocated amount"
					value={
						<Money
							minor={allocation.amountMinor}
							currency={allocation.currency}
						/>
					}
				/>
				<StatTile
					label="Order date"
					value={formatDate(order.orderDate, "long")}
				/>
				<StatTile
					label="Category"
					value={
						<span className="text-sm">
							{allocation.categoryCode ? `${allocation.categoryCode} · ` : ""}
							{allocation.categoryName ?? "—"}
						</span>
					}
				/>
				<StatTile
					label="Reimbursement"
					value={<ReimbursementTag status={allocation.reimbursementStatus} />}
					hint={order.paymentLast4 ? `Card •${order.paymentLast4}` : undefined}
				/>
			</div>
			<div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
				<Panel title={`Items · ${items.length}`} bodyClassName="p-0">
					<table className="w-full text-xs">
						<tbody>
							{items.map((item) => (
								<tr
									key={item.id}
									className="h-7 border-b border-border last:border-0"
								>
									<td className="px-3">
										{item.title}
										{item.variant && (
											<span className="ml-1 text-muted-foreground">
												{item.variant}
											</span>
										)}
									</td>
									<td className="px-2 text-right font-mono text-muted-foreground">
										×{item.quantity}
									</td>
									<td className="px-3 text-right">
										<Money
											minor={item.totalMinor}
											currency={allocation.currency}
										/>
									</td>
								</tr>
							))}
							{items.length === 0 && (
								<tr>
									<td className="px-3 py-3 text-muted-foreground">
										No line items recorded.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</Panel>
				<Panel title={`Documents · ${documents.length}`}>
					{documents.length === 0 ? (
						<div className="text-xs text-red-600 dark:text-red-400">
							No invoice on file.
						</div>
					) : (
						<ul className="flex flex-col gap-1.5 text-xs">
							{documents.map((doc) => (
								<li key={doc.id} className="flex items-center gap-2">
									<Tag>{doc.kind}</Tag>
									<a
										href={sharedDocumentHref(entityId, doc.id)}
										target="_blank"
										rel="noreferrer"
										className="min-w-0 flex-1 truncate text-primary hover:underline"
									>
										{doc.fileName}
									</a>
									<span className="font-mono text-[10px] text-muted-foreground">
										{formatBytes(doc.sizeBytes)}
									</span>
									<a
										href={sharedDocumentHref(entityId, doc.id, true)}
										aria-label={`Download ${doc.fileName}`}
										className="text-muted-foreground hover:text-foreground"
									>
										<IconDownload className="size-3.5" />
									</a>
								</li>
							))}
						</ul>
					)}
				</Panel>
			</div>
		</div>
	);
}

export function SharedClaims({ entityId }: { entityId: string }) {
	const query = useQuery({
		queryKey: shareKeys.claims(entityId),
		queryFn: () => listSharedClaims({ data: { entityId } }),
	});
	const [open, setOpen] = useState<string | null>(null);
	if (query.isLoading)
		return <div className="p-4 text-xs text-muted-foreground">Loading…</div>;
	const claims = query.data ?? [];
	return (
		<div className="flex flex-col gap-2 p-4">
			{claims.length === 0 ? (
				<EmptyState title="No reimbursement claims">
					Claims between this entity and others appear here.
				</EmptyState>
			) : (
				claims.map((claim) => (
					<section
						key={claim.id}
						className="rounded border border-border bg-card"
					>
						<button
							type="button"
							className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/50"
							onClick={() => setOpen(open === claim.id ? null : claim.id)}
						>
							<Tag
								tone={claim.direction === "receivable" ? "success" : "warning"}
							>
								{claim.direction === "receivable" ? "Owed to us" : "We owe"}
							</Tag>
							<EntityChip entity={claim.counterparty} short />
							<span className="font-mono text-muted-foreground">
								{claim.reference ?? claim.id.slice(0, 8)}
							</span>
							<Tag
								tone={
									claim.status === "paid"
										? "success"
										: claim.status === "submitted"
											? "info"
											: "neutral"
								}
							>
								{claim.status}
							</Tag>
							<span className="ml-auto font-mono text-muted-foreground">
								{formatDate(claim.createdAt)}
							</span>
							<Money minor={claim.totalMinor} currency={claim.currency} />
						</button>
						{open === claim.id && (
							<table className="w-full border-t border-border text-xs">
								<tbody>
									{claim.lines.map((line) => (
										<tr
											key={`${line.orderId}-${line.amountMinor}`}
											className="h-7 border-b border-border last:border-0"
										>
											<td className="px-3 font-mono">
												{formatDate(line.orderDate)}
											</td>
											<td className="px-2">
												{line.viewable ? (
													<Link
														to="/share/$entityId/orders/$orderId"
														params={{ entityId, orderId: line.orderId }}
														className="font-mono text-primary hover:underline"
													>
														{line.externalOrderId}
													</Link>
												) : (
													<span className="font-mono">
														{line.externalOrderId}
													</span>
												)}
												<span className="ml-1.5 text-muted-foreground">
													{line.merchantName ?? line.source}
												</span>
											</td>
											<td className="px-3 text-right">
												<Money
													minor={line.amountMinor}
													currency={line.currency}
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</section>
				))
			)}
		</div>
	);
}

export function SharedShellHeader({
	email,
	onSignOut,
	appLabel,
}: {
	email: string;
	onSignOut: () => void;
	appLabel: string;
}) {
	return (
		<header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
			<Link to="/share" className="flex items-center gap-2">
				<span className="grid size-6 place-items-center rounded-sm bg-primary font-mono text-[11px] font-bold text-primary-foreground">
					<IconShare className="size-3.5" />
				</span>
				<span className="font-mono text-xs font-semibold uppercase tracking-[0.12em]">
					{appLabel}
				</span>
				<Tag tone="neutral">read-only</Tag>
			</Link>
			<div className={cn("ml-auto flex items-center gap-2")}>
				<span className="hidden max-w-48 truncate text-xs text-muted-foreground sm:block">
					{email}
				</span>
				<Button size="sm" variant="ghost" onClick={onSignOut}>
					Sign out
				</Button>
			</div>
		</header>
	);
}
