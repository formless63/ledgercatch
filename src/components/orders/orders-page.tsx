/** Orders: filterable, paginated table of every order. Filters live in the URL. */
import {
	IconArchive,
	IconCheck,
	IconChevronLeft,
	IconChevronRight,
	IconFileInvoice,
	IconFileOff,
	IconFilterOff,
	IconPackages,
	IconPlus,
	IconSearch,
	IconSend,
	IconTableExport,
	IconX,
} from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	formatDate,
	ORDER_STATUS_TONES,
	STORE_META,
	storeLabel,
} from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Input,
	Kbd,
	Money,
	ReimbursementTag,
	Select,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import {
	type EntityRow,
	ledgerKeys,
	useBootstrap,
} from "#/features/ledger/hooks";
import {
	ORDER_VIEWS,
	type OrderListInput,
	REIMBURSEMENT_FILTERS,
} from "#/features/ledger/inputs";
import { listOrders } from "#/features/ledger/ledger.functions";
import type { OrderListRow } from "#/features/ledger/ledger.server";
import { cn } from "#/lib/utils";
import { STORE_IDS } from "#/shared/capture";
import { ManualOrderDialog } from "./manual-order-dialog";
import {
	categoryLabel,
	downloadText,
	errorMessage,
	minorToDecimal,
	paymentMethodLabel,
	ReviewTag,
	toCsv,
	useHotkeys,
	useOrderActions,
} from "./shared";

const routeApi = getRouteApi("/app/orders/");

export type OrdersSearch = {
	q?: string;
	entity?: string;
	source?: string;
	status?: string;
	reimbursement?: string;
	missingInvoice?: boolean;
	view?: string;
	from?: string;
	to?: string;
	sort?: string;
	page?: number;
	size?: number;
};

const ORDER_STATUSES = [
	"placed",
	"processing",
	"shipped",
	"delivered",
	"cancelled",
	"returned",
	"unknown",
] as const;
const SORTS = ["date_desc", "date_asc", "total_desc", "captured_desc"] as const;
const PAGE_SIZES = [50, 100, 200] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(list: readonly T[], value: unknown) {
	return list.includes(value as T) ? (value as T) : undefined;
}

/** URL search → validated listOrders input (bad values are dropped). */
export function toListInput(search: OrdersSearch): OrderListInput {
	const size = oneOf(PAGE_SIZES.map(String), String(search.size ?? 100));
	const limit = size ? Number(size) : 100;
	const page = Math.max(1, Math.floor(search.page ?? 1));
	const entity =
		search.entity === "unassigned" || UUID.test(search.entity ?? "")
			? search.entity
			: undefined;
	return {
		view: oneOf(ORDER_VIEWS, search.view) ?? "all",
		entityId: entity,
		source: oneOf(STORE_IDS, search.source),
		status: oneOf(ORDER_STATUSES, search.status),
		reimbursement: oneOf(REIMBURSEMENT_FILTERS, search.reimbursement),
		missingInvoice: search.missingInvoice || undefined,
		from: DATE.test(search.from ?? "") ? search.from : undefined,
		to: DATE.test(search.to ?? "") ? search.to : undefined,
		q: search.q?.trim() ? search.q.trim().slice(0, 200) : undefined,
		sort: oneOf(SORTS, search.sort) ?? "date_desc",
		limit,
		offset: (page - 1) * limit,
	};
}

export function OrdersPage() {
	const search = routeApi.useSearch() as OrdersSearch;
	const navigate = useNavigate({ from: "/app/orders/" });
	const bootstrap = useBootstrap();
	const { activeEntities, entityById, categoryById, paymentMethodById } =
		bootstrap;
	const { bulk, exportOrders } = useOrderActions();
	const [manualOpen, setManualOpen] = useState(false);

	const input = useMemo(() => toListInput(search), [search]);
	const query = useQuery({
		queryKey: ledgerKeys.orders(input),
		queryFn: () => listOrders({ data: input }),
		placeholderData: keepPreviousData,
		refetchInterval: 60_000,
	});
	const rows = query.data?.orders ?? [];
	const total = query.data?.total ?? 0;
	const limit = input.limit ?? 100;
	const offset = input.offset ?? 0;

	const setSearch = (
		patch: Partial<OrdersSearch>,
		options: { keepPage?: boolean } = {},
	) =>
		void navigate({
			search: (prev: OrdersSearch) => {
				const next: OrdersSearch = { ...prev, ...patch };
				if (!options.keepPage) delete next.page;
				for (const key of Object.keys(next) as Array<keyof OrdersSearch>)
					if (
						next[key] === undefined ||
						next[key] === "" ||
						next[key] === false
					)
						delete next[key];
				return next;
			},
			replace: true,
		});

	/* debounced search box */
	const [q, setQ] = useState(search.q ?? "");
	useEffect(() => setQ(search.q ?? ""), [search.q]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: debounce only on typing
	useEffect(() => {
		if ((search.q ?? "") === q) return;
		const timer = setTimeout(() => setSearch({ q: q || undefined }), 300);
		return () => clearTimeout(timer);
	}, [q]);

	/* selection + keyboard focus */
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [cursor, setCursor] = useState(-1);
	const selectedIds = rows
		.filter((row) => selected.has(row.id))
		.map((r) => r.id);
	const allChecked = rows.length > 0 && selectedIds.length === rows.length;

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
	useEffect(() => {
		setSelected(new Set());
		setCursor(-1);
	}, [input]);

	const toggle = (id: string) =>
		setSelected((set) => {
			const next = new Set(set);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const open = (row: OrderListRow | undefined) => {
		if (row)
			void navigate({
				to: "/app/orders/$orderId",
				params: { orderId: row.id },
			});
	};

	useHotkeys((event) => {
		if (event.key === "j" || event.key === "ArrowDown") {
			event.preventDefault();
			setCursor((c) => Math.min(rows.length - 1, c + 1));
		} else if (event.key === "k" || event.key === "ArrowUp") {
			event.preventDefault();
			setCursor((c) => Math.max(0, c - 1));
		} else if (event.key === "o" || (event.key === "Enter" && cursor >= 0)) {
			const target = event.target as HTMLElement | null;
			if (event.key === "Enter" && target?.closest("button, a")) return;
			open(rows[cursor]);
		} else if (event.key === "x") {
			const row = rows[cursor];
			if (row) toggle(row.id);
		} else if (event.key === "/") {
			event.preventDefault();
			document.getElementById("orders-search")?.focus();
		} else if (event.key === "Escape") setSelected(new Set());
	});
	useEffect(() => {
		const row = rows[cursor];
		if (row)
			document
				.getElementById(`order-row-${row.id}`)
				?.scrollIntoView({ block: "nearest" });
	}, [cursor, rows]);

	/* CSV */
	const csv = useMutation({
		mutationFn: async () => {
			const result = await listOrders({
				data: { ...input, limit: 500, offset: 0 },
			});
			const header = [
				"Order date",
				"Store",
				"Merchant",
				"Order ID",
				"Status",
				"Review",
				"Entity",
				"Category",
				"Payment method",
				"Paying entity",
				"Currency",
				"Total",
				"Tax",
				"Items",
				"First item",
				"Allocations",
				"Reimbursement",
				"Invoices",
				"Tags",
				"URL",
			];
			const lines = result.orders.map((row) => {
				const method = row.paymentMethodId
					? paymentMethodById.get(row.paymentMethodId)
					: undefined;
				const payer = method?.payingEntityId
					? entityById.get(method.payingEntityId)
					: undefined;
				const category = row.categoryId
					? categoryById.get(row.categoryId)
					: undefined;
				return [
					row.orderDate ?? "",
					storeLabel(row.source),
					row.merchantName ?? "",
					row.externalOrderId,
					row.status,
					row.reviewState,
					row.entityId ? (entityById.get(row.entityId)?.name ?? "") : "",
					category ? categoryLabel(category) : "",
					method ? paymentMethodLabel(method) : (row.paymentHint ?? ""),
					payer?.name ?? "",
					row.currency ?? "",
					minorToDecimal(row.totalMinor),
					minorToDecimal(row.taxMinor),
					row.itemCount,
					row.firstItemTitle ?? "",
					row.allocations
						.map(
							(a) =>
								`${entityById.get(a.entityId)?.name ?? "?"}: ${minorToDecimal(a.amountMinor)}`,
						)
						.join("; "),
					row.allocations
						.filter((a) => a.reimbursable)
						.map((a) => a.reimbursementStatus)
						.join("; "),
					row.documentCount,
					row.tags.join("; "),
					row.orderUrl ?? "",
				];
			});
			downloadText(
				`orders-${new Date().toISOString().slice(0, 10)}.csv`,
				toCsv([header, ...lines]),
				"text/csv;charset=utf-8",
			);
			return { count: result.orders.length, total: result.total };
		},
		onSuccess: ({ count, total: all }) =>
			toast.success(
				count < all
					? `Exported ${count} of ${all} orders (CSV is capped at 500 — narrow the filter)`
					: `Exported ${count} orders`,
			),
		onError: (error) => toast.error(errorMessage(error)),
	});

	const activeFilters =
		Object.keys(search).filter(
			(key) => key !== "page" && key !== "size" && key !== "sort",
		).length > 0;
	const view = input.view ?? "all";

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
				<h1 className="text-base font-semibold tracking-tight">Orders</h1>
				<span className="font-mono text-xs text-muted-foreground">
					{query.isPending ? "…" : total.toLocaleString()}
				</span>
				<div
					role="tablist"
					aria-label="Review state"
					className="ml-2 inline-flex overflow-hidden rounded-sm border border-border"
				>
					{(["all", "inbox", "filed", "ignored"] as const).map((value) => (
						<button
							key={value}
							type="button"
							role="tab"
							aria-selected={view === value}
							onClick={() =>
								setSearch({ view: value === "all" ? undefined : value })
							}
							className={cn(
								"h-6 px-2.5 text-xs capitalize",
								view === value
									? "bg-primary/15 font-semibold text-primary"
									: "text-muted-foreground hover:bg-accent",
							)}
						>
							{value}
						</button>
					))}
				</div>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<Button
						onClick={() => csv.mutate()}
						disabled={csv.isPending || total === 0}
						title="Download the current filter as CSV (up to 500 rows)"
					>
						<IconTableExport />
						{csv.isPending ? "Exporting…" : "CSV"}
					</Button>
					<Button variant="primary" onClick={() => setManualOpen(true)}>
						<IconPlus />
						Add order
					</Button>
				</div>
			</header>

			{/* Filter bar */}
			<div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-1.5">
				<div className="relative w-full sm:w-56">
					<IconSearch className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						id="orders-search"
						type="search"
						aria-label="Search orders"
						placeholder="Search…  /"
						value={q}
						onChange={(event) => setQ(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") setSearch({ q: q || undefined });
							if (event.key === "Escape") (event.target as HTMLElement).blur();
						}}
						className="pl-7"
					/>
				</div>
				<Select
					aria-label="Entity"
					value={search.entity ?? ""}
					onChange={(event) =>
						setSearch({ entity: event.target.value || undefined })
					}
					className="w-auto max-w-40"
				>
					<option value="">All entities</option>
					<option value="unassigned">Unassigned</option>
					{activeEntities.map((entity) => (
						<option key={entity.id} value={entity.id}>
							{entity.name}
						</option>
					))}
				</Select>
				<Select
					aria-label="Store"
					value={input.source ?? ""}
					onChange={(event) =>
						setSearch({ source: event.target.value || undefined })
					}
					className="w-auto"
				>
					<option value="">All stores</option>
					{STORE_IDS.map((id) => (
						<option key={id} value={id}>
							{STORE_META[id].label}
						</option>
					))}
				</Select>
				<Select
					aria-label="Order status"
					value={input.status ?? ""}
					onChange={(event) =>
						setSearch({ status: event.target.value || undefined })
					}
					className="w-auto capitalize"
				>
					<option value="">Any status</option>
					{ORDER_STATUSES.map((status) => (
						<option key={status} value={status}>
							{status}
						</option>
					))}
				</Select>
				<Select
					aria-label="Reimbursement"
					value={input.reimbursement ?? ""}
					onChange={(event) =>
						setSearch({ reimbursement: event.target.value || undefined })
					}
					className="w-auto"
				>
					<option value="">Any reimbursement</option>
					<option value="reimbursable">Reimbursable</option>
					<option value="pending">Pending claim</option>
					<option value="submitted">Claim submitted</option>
					<option value="reimbursed">Reimbursed</option>
				</Select>
				<label className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-sm border border-border px-2 text-xs">
					<input
						type="checkbox"
						checked={Boolean(input.missingInvoice)}
						onChange={(event) =>
							setSearch({ missingInvoice: event.target.checked || undefined })
						}
						className="size-3 accent-[var(--primary)]"
					/>
					Missing invoice
				</label>
				<div className="flex items-center gap-1">
					<Input
						type="date"
						aria-label="From date"
						value={input.from ?? ""}
						onChange={(event) =>
							setSearch({ from: event.target.value || undefined })
						}
						className="w-[8.5rem]"
					/>
					<span className="text-xs text-muted-foreground">–</span>
					<Input
						type="date"
						aria-label="To date"
						value={input.to ?? ""}
						onChange={(event) =>
							setSearch({ to: event.target.value || undefined })
						}
						className="w-[8.5rem]"
					/>
				</div>
				<Select
					aria-label="Sort"
					value={input.sort}
					onChange={(event) =>
						setSearch({
							sort:
								event.target.value === "date_desc"
									? undefined
									: event.target.value,
						})
					}
					className="w-auto"
				>
					<option value="date_desc">Newest first</option>
					<option value="date_asc">Oldest first</option>
					<option value="total_desc">Largest total</option>
					<option value="captured_desc">Recently captured</option>
				</Select>
				{activeFilters && (
					<Button
						variant="ghost"
						onClick={() => void navigate({ search: {}, replace: true })}
					>
						<IconFilterOff />
						Clear
					</Button>
				)}
			</div>

			{selectedIds.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5 text-xs">
					<span className="font-mono font-semibold">
						{selectedIds.length} selected
					</span>
					<Select
						aria-label="Assign selected to entity"
						value=""
						className="w-auto"
						onChange={(event) => {
							const value = event.target.value;
							if (value)
								bulk.mutate({
									ids: selectedIds,
									entityId: value === "none" ? null : value,
								});
						}}
					>
						<option value="">Assign entity…</option>
						{activeEntities.map((entity) => (
							<option key={entity.id} value={entity.id}>
								{entity.name}
							</option>
						))}
						<option value="none">Unassign</option>
					</Select>
					<Button
						onClick={() => {
							bulk.mutate({ ids: selectedIds, reviewState: "filed" });
							setSelected(new Set());
						}}
					>
						<IconCheck />
						File
					</Button>
					<Button
						onClick={() => {
							bulk.mutate({ ids: selectedIds, reviewState: "ignored" });
							setSelected(new Set());
						}}
					>
						<IconArchive />
						Ignore
					</Button>
					<Button
						disabled={exportOrders.isPending}
						onClick={() => exportOrders.mutate({ orderIds: selectedIds })}
					>
						<IconSend />
						Queue export
					</Button>
					<Button
						variant="ghost"
						aria-label="Clear selection"
						onClick={() => setSelected(new Set())}
					>
						<IconX />
						Clear
					</Button>
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-auto">
				{query.isPending ? (
					<p className="p-4 text-xs text-muted-foreground">Loading orders…</p>
				) : query.isError ? (
					<p className="p-4 text-xs text-red-600 dark:text-red-400">
						Could not load orders: {errorMessage(query.error)}
					</p>
				) : rows.length === 0 ? (
					<div className="p-4">
						<EmptyState
							icon={<IconPackages className="size-6" />}
							title={
								activeFilters
									? "No orders match these filters"
									: "No orders yet"
							}
							action={
								activeFilters ? (
									<Button
										onClick={() => void navigate({ search: {}, replace: true })}
									>
										<IconFilterOff />
										Clear filters
									</Button>
								) : (
									<Button onClick={() => setManualOpen(true)}>
										<IconPlus />
										Add order manually
									</Button>
								)
							}
						>
							{activeFilters
								? "Try widening the date range or clearing the search."
								: "Install the browser extension to capture orders while you browse your store order history."}
						</EmptyState>
					</div>
				) : (
					<table
						className={cn(
							"w-full border-collapse text-xs",
							query.isPlaceholderData && "opacity-60",
						)}
					>
						<thead className="sticky top-0 z-10 bg-card">
							<tr className="h-7 border-b border-border text-left">
								<th className="w-8 px-2">
									<input
										type="checkbox"
										aria-label="Select all on this page"
										checked={allChecked}
										onChange={() =>
											setSelected(
												allChecked ? new Set() : new Set(rows.map((r) => r.id)),
											)
										}
										className="size-3.5 align-middle accent-[var(--primary)]"
									/>
								</th>
								<th className="label-caps w-20 px-2">Date</th>
								<th className="label-caps hidden w-16 px-2 md:table-cell">
									Store
								</th>
								<th className="label-caps px-2">Merchant · items</th>
								<th className="label-caps hidden px-2 xl:table-cell">
									Order #
								</th>
								<th className="label-caps hidden px-2 lg:table-cell">Status</th>
								<th className="label-caps px-2">Entity</th>
								<th className="label-caps hidden px-2 lg:table-cell">Reimb.</th>
								<th className="label-caps hidden w-8 px-2 sm:table-cell">
									<span className="sr-only">Invoice</span>
								</th>
								<th className="label-caps hidden px-2 md:table-cell">Review</th>
								<th className="label-caps px-2 text-right">Total</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row, index) => (
								<OrderTableRow
									key={row.id}
									row={row}
									checked={selected.has(row.id)}
									focused={index === cursor}
									onToggle={() => toggle(row.id)}
									onOpen={() => open(row)}
									entityById={entityById}
								/>
							))}
						</tbody>
					</table>
				)}
			</div>

			<footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
				<span className="font-mono">
					{total === 0
						? "0"
						: `${(offset + 1).toLocaleString()}–${Math.min(offset + rows.length, total).toLocaleString()}`}{" "}
					of {total.toLocaleString()}
				</span>
				<Select
					aria-label="Rows per page"
					value={String(limit)}
					onChange={(event) =>
						setSearch({
							size:
								event.target.value === "100"
									? undefined
									: Number(event.target.value),
						})
					}
					className="h-5 w-auto text-[11px]"
				>
					{PAGE_SIZES.map((size) => (
						<option key={size} value={size}>
							{size} / page
						</option>
					))}
				</Select>
				<div className="flex items-center gap-1">
					<Button
						size="xs"
						aria-label="Previous page"
						disabled={offset === 0}
						onClick={() =>
							setSearch(
								{ page: Math.floor(offset / limit) || undefined },
								{ keepPage: true },
							)
						}
					>
						<IconChevronLeft />
					</Button>
					<Button
						size="xs"
						aria-label="Next page"
						disabled={offset + rows.length >= total}
						onClick={() =>
							setSearch(
								{ page: Math.floor(offset / limit) + 2 },
								{ keepPage: true },
							)
						}
					>
						<IconChevronRight />
					</Button>
				</div>
				<span className="ml-auto hidden items-center gap-3 md:flex">
					<span className="inline-flex items-center gap-1">
						<Kbd>j</Kbd>
						<Kbd>k</Kbd> move
					</span>
					<span className="inline-flex items-center gap-1">
						<Kbd>x</Kbd> select
					</span>
					<span className="inline-flex items-center gap-1">
						<Kbd>o</Kbd> open
					</span>
					<span className="inline-flex items-center gap-1">
						<Kbd>/</Kbd> search
					</span>
				</span>
			</footer>

			<ManualOrderDialog
				open={manualOpen}
				onOpenChange={setManualOpen}
				onCreated={(id) =>
					void navigate({ to: "/app/orders/$orderId", params: { orderId: id } })
				}
			/>
		</div>
	);
}

function OrderTableRow({
	row,
	checked,
	focused,
	onToggle,
	onOpen,
	entityById,
}: {
	row: OrderListRow;
	checked: boolean;
	focused: boolean;
	onToggle: () => void;
	onOpen: () => void;
	entityById: Map<string, EntityRow>;
}) {
	const entityIds = [...new Set(row.allocations.map((a) => a.entityId))];
	const reimbursable = row.allocations.filter((a) => a.reimbursable);
	return (
		<tr
			id={`order-row-${row.id}`}
			onClick={onOpen}
			className={cn(
				"h-7 cursor-pointer border-b border-border/60 hover:bg-accent/50",
				checked && "bg-primary/5",
				focused && "outline outline-1 -outline-offset-1 outline-primary",
			)}
		>
			<td className="px-2">
				<input
					type="checkbox"
					aria-label={`Select order ${row.externalOrderId}`}
					checked={checked}
					onChange={onToggle}
					onClick={(event) => event.stopPropagation()}
					className="size-3.5 align-middle accent-[var(--primary)]"
				/>
			</td>
			<td className="whitespace-nowrap px-2 font-mono text-[11px] text-muted-foreground">
				{formatDate(row.orderDate)}
			</td>
			<td className="hidden px-2 md:table-cell">
				<StoreMark source={row.source} className="[&>span:last-child]:hidden" />
			</td>
			<td className="max-w-0 px-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<a
						href={`/app/orders/${row.id}`}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onOpen();
						}}
						className="shrink-0 truncate font-medium hover:underline"
					>
						{row.merchantName ?? storeLabel(row.source)}
					</a>
					<span className="truncate text-[11px] text-muted-foreground">
						{row.firstItemTitle}
						{row.itemCount > 1 && (
							<span className="ml-1 font-mono text-[10px]">
								+{row.itemCount - 1}
							</span>
						)}
					</span>
				</div>
			</td>
			<td className="hidden whitespace-nowrap px-2 font-mono text-[11px] text-muted-foreground xl:table-cell">
				{row.externalOrderId}
			</td>
			<td className="hidden px-2 lg:table-cell">
				<Tag tone={ORDER_STATUS_TONES[row.status] ?? "neutral"}>
					{row.status}
				</Tag>
			</td>
			<td className="px-2">
				<div className="flex max-w-40 items-center gap-1 overflow-hidden">
					{entityIds.length > 1 ? (
						entityIds.map((id) => (
							<EntityChip key={id} entity={entityById.get(id)} short />
						))
					) : (
						<EntityChip
							entity={row.entityId ? entityById.get(row.entityId) : undefined}
							short
						/>
					)}
				</div>
			</td>
			<td className="hidden px-2 lg:table-cell">
				{reimbursable[0] ? (
					<ReimbursementTag status={reimbursable[0].reimbursementStatus} />
				) : null}
			</td>
			<td className="hidden px-2 sm:table-cell">
				{row.documentCount > 0 ? (
					<IconFileInvoice
						className="size-3.5 text-emerald-600 dark:text-emerald-400"
						aria-label="Has invoice"
					/>
				) : (
					<IconFileOff
						className="size-3.5 text-red-500/70"
						aria-label="Missing invoice"
					/>
				)}
			</td>
			<td className="hidden px-2 md:table-cell">
				<ReviewTag state={row.reviewState} />
			</td>
			<td className="whitespace-nowrap px-2 text-right">
				<Money minor={row.totalMinor} currency={row.currency} />
			</td>
		</tr>
	);
}
