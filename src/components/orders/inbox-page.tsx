/** Inbox: keyboard-first triage queue of orders with reviewState "inbox". */
import {
	IconAdjustmentsBolt,
	IconArchive,
	IconCheck,
	IconFileInvoice,
	IconFileOff,
	IconInbox,
	IconPlugConnected,
	IconPlus,
	IconUsersGroup,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDate, formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	EntityDot,
	Kbd,
	Money,
	Select,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import {
	type EntityRow,
	ledgerKeys,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import type { OrderListInput } from "#/features/ledger/inputs";
import {
	listOrders,
	runRulesOnInbox,
} from "#/features/ledger/ledger.functions";
import type { OrderListRow } from "#/features/ledger/ledger.server";
import { cn } from "#/lib/utils";
import { OrderInspector } from "./inspector";
import { ManualOrderDialog } from "./manual-order-dialog";
import {
	errorMessage,
	nextReimbursable,
	reimbursableLabel,
	useHotkeys,
	useMediaQuery,
	useOrderActions,
} from "./shared";

type Sort = "captured_desc" | "date_desc" | "total_desc";

export function InboxPage() {
	const navigate = useNavigate();
	const bootstrap = useBootstrap();
	const { activeEntities, entityById } = bootstrap;
	const invalidate = useInvalidateLedger();
	const { update, bulk } = useOrderActions();
	const isWide = useMediaQuery("(min-width: 1024px)");
	const [sort, setSort] = useState<Sort>("captured_desc");
	const [manualOpen, setManualOpen] = useState(false);

	const filters: OrderListInput = { view: "inbox", sort, limit: 300 };
	const query = useQuery({
		queryKey: ledgerKeys.orders(filters),
		queryFn: () => listOrders({ data: filters }),
		refetchInterval: 15_000,
	});
	const rows = query.data?.orders ?? [];
	const total = query.data?.total ?? 0;

	/* current row + multi-select */
	const [currentId, setCurrentId] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const lastIndex = useRef(0);
	const currentIndex = rows.findIndex((row) => row.id === currentId);
	if (currentIndex >= 0) lastIndex.current = currentIndex;
	const current = currentIndex >= 0 ? rows[currentIndex] : undefined;

	// Order created from the dialog: keep it focused until the refetch lands.
	const pendingFocus = useRef<string | null>(null);
	const fetching = query.isFetching;
	useEffect(() => {
		if (currentIndex === -1 && rows.length > 0) {
			if (
				pendingFocus.current &&
				pendingFocus.current === currentId &&
				fetching
			)
				return;
			pendingFocus.current = null;
			const index = Math.min(lastIndex.current, rows.length - 1);
			setCurrentId(rows[index]?.id ?? null);
		}
	}, [currentIndex, rows, currentId, fetching]);

	useEffect(() => {
		if (!currentId) return;
		document
			.getElementById(`inbox-row-${currentId}`)
			?.scrollIntoView({ block: "nearest" });
	}, [currentId]);

	// Drop selections that left the inbox.
	const visibleIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
	const selectedIds = [...selected].filter((id) => visibleIds.has(id));

	const rules = useMutation({
		mutationFn: () => runRulesOnInbox(),
		onSuccess: (result) =>
			toast.success(
				result.changed
					? `Rules updated ${result.changed} order${result.changed === 1 ? "" : "s"}`
					: "No rule changes",
			),
		onError: (error) => toast.error(errorMessage(error)),
		onSettled: () => void invalidate(),
	});

	/* actions */
	const move = (delta: number) => {
		if (rows.length === 0) return;
		const base = currentIndex >= 0 ? currentIndex : 0;
		const next = Math.max(0, Math.min(rows.length - 1, base + delta));
		setCurrentId(rows[next]?.id ?? null);
	};

	const assign = (row: OrderListRow | undefined, entityId: string | null) => {
		if (!row || row.entityId === entityId) return;
		update.mutate({ id: row.id, entityId });
	};

	const cycleReimbursable = (
		row: OrderListRow | undefined,
		value?: boolean | null,
	) => {
		if (!row) return;
		const next =
			value === undefined ? nextReimbursable(row.reimbursableOverride) : value;
		update.mutate({ id: row.id, reimbursableOverride: next });
		toast(`Reimbursable: ${reimbursableLabel(next)}`, { duration: 1200 });
	};

	const setReview = (
		row: OrderListRow | undefined,
		reviewState: "filed" | "ignored",
	) => {
		if (!row) return;
		if (reviewState === "filed" && !row.entityId)
			toast.warning("Filed without an entity — it won't be allocated", {
				duration: 2500,
			});
		update.mutate({ id: row.id, reviewState });
		toast(
			`${reviewState === "filed" ? "Filed" : "Ignored"} ${row.merchantName ?? row.externalOrderId}`,
			{
				action: {
					label: "Undo",
					onClick: () => update.mutate({ id: row.id, reviewState: "inbox" }),
				},
			},
		);
	};

	const bulkUpdate = (changes: {
		entityId?: string | null;
		reviewState?: "filed" | "ignored";
	}) => {
		if (selectedIds.length === 0) return;
		bulk.mutate({ ids: selectedIds, ...changes });
		if (changes.reviewState) setSelected(new Set());
	};

	const toggleSelected = (id: string) =>
		setSelected((set) => {
			const next = new Set(set);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const openDetail = (row: OrderListRow | undefined) => {
		if (row)
			void navigate({
				to: "/app/orders/$orderId",
				params: { orderId: row.id },
			});
	};

	useHotkeys((event) => {
		const key = event.key;
		const onControl =
			event.target instanceof HTMLElement && event.target.closest("button, a");
		if (key === "j" || key === "ArrowDown") {
			event.preventDefault();
			move(1);
		} else if (key === "k" || key === "ArrowUp") {
			event.preventDefault();
			move(-1);
		} else if (/^[1-9]$/.test(key) && !event.shiftKey) {
			const entity = activeEntities[Number(key) - 1];
			if (entity) assign(current, entity.id);
		} else if (key === "0") {
			assign(current, null);
		} else if (key === "r") {
			cycleReimbursable(current);
		} else if (key === "E" && event.shiftKey) {
			bulkUpdate({ reviewState: "filed" });
		} else if (key === "e" || (key === "Enter" && !onControl)) {
			event.preventDefault();
			setReview(current, "filed");
		} else if (key === "i") {
			setReview(current, "ignored");
		} else if (key === "x") {
			if (current) toggleSelected(current.id);
		} else if (key === "o") {
			openDetail(current);
		} else if (key === "Escape") {
			setSelected(new Set());
		}
	});

	/* empty / onboarding states */
	const noEntities = bootstrap.isSuccess && activeEntities.length === 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
				<h1 className="text-base font-semibold tracking-tight">Inbox</h1>
				<span className="font-mono text-xs text-muted-foreground">
					{query.isPending ? "…" : total}
				</span>
				{query.isFetching && !query.isPending && (
					<span
						className="size-1.5 animate-pulse rounded-full bg-primary"
						title="Refreshing"
					/>
				)}
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<Select
						aria-label="Sort inbox"
						value={sort}
						onChange={(event) => setSort(event.target.value as Sort)}
						className="w-auto"
					>
						<option value="captured_desc">Newest captured</option>
						<option value="date_desc">Order date</option>
						<option value="total_desc">Largest total</option>
					</Select>
					<Button
						onClick={() => rules.mutate()}
						disabled={rules.isPending || rows.length === 0}
					>
						<IconAdjustmentsBolt />
						{rules.isPending ? "Applying…" : "Apply rules to inbox"}
					</Button>
					<Button variant="primary" onClick={() => setManualOpen(true)}>
						<IconPlus />
						Add order
					</Button>
				</div>
			</header>

			{noEntities && (
				<div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
					<IconUsersGroup className="size-3.5" />
					Set up your entities (Personal, businesses) before triaging — number
					keys assign orders to them.
					<Link
						to="/app/settings"
						className="font-semibold underline underline-offset-2"
					>
						Open settings
					</Link>
				</div>
			)}

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
								bulkUpdate({ entityId: value === "none" ? null : value });
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
					<Button onClick={() => bulkUpdate({ reviewState: "filed" })}>
						<IconCheck />
						File <Kbd>⇧E</Kbd>
					</Button>
					<Button onClick={() => bulkUpdate({ reviewState: "ignored" })}>
						<IconArchive />
						Ignore
					</Button>
					<Button
						variant="ghost"
						onClick={() => setSelected(new Set(rows.map((row) => row.id)))}
					>
						Select all
					</Button>
					<Button
						variant="ghost"
						aria-label="Clear selection"
						onClick={() => setSelected(new Set())}
					>
						<IconX />
						Clear <Kbd>esc</Kbd>
					</Button>
				</div>
			)}

			<div className="flex min-h-0 flex-1">
				<div
					className={cn(
						"min-h-0 overflow-y-auto",
						isWide
							? "w-[46%] min-w-[420px] max-w-[640px] border-r border-border"
							: "w-full",
					)}
				>
					{query.isPending ? (
						<ListSkeleton />
					) : query.isError ? (
						<p className="p-4 text-xs text-red-600 dark:text-red-400">
							Could not load the inbox: {errorMessage(query.error)}
						</p>
					) : rows.length === 0 ? (
						<div className="p-4">
							<EmptyState
								icon={<IconInbox className="size-6" />}
								title="Inbox zero"
								action={
									<div className="flex flex-wrap justify-center gap-2">
										<Button
											onClick={() =>
												void navigate({ to: "/app/settings/extension" })
											}
										>
											<IconPlugConnected />
											Install the extension
										</Button>
										<Button onClick={() => setManualOpen(true)}>
											<IconPlus />
											Add order manually
										</Button>
									</div>
								}
							>
								New captures land here automatically while you browse your order
								history on Amazon, AliExpress, eBay, DigiKey and others.
								{bootstrap.data?.lastCapture
									? ` Last capture ${formatRelative(bootstrap.data.lastCapture.receivedAt)}.`
									: " No captures received yet."}
							</EmptyState>
						</div>
					) : (
						<div role="listbox" aria-label="Inbox orders" aria-multiselectable>
							{rows.map((row) => (
								<InboxRow
									key={row.id}
									row={row}
									current={row.id === current?.id}
									checked={selected.has(row.id)}
									entity={
										row.entityId ? entityById.get(row.entityId) : undefined
									}
									onToggle={() => toggleSelected(row.id)}
									onClick={() => {
										if (isWide) setCurrentId(row.id);
										else openDetail(row);
									}}
								/>
							))}
							{total > rows.length && (
								<p className="px-3 py-2 text-center text-[11px] text-muted-foreground">
									Showing {rows.length} of {total}.{" "}
									<Link
										to="/app/orders"
										search={{ view: "inbox" }}
										className="underline underline-offset-2"
									>
										See all in Orders
									</Link>
								</p>
							)}
						</div>
					)}
				</div>
				{isWide && (
					<aside
						aria-label="Order inspector"
						className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background"
					>
						{current ? (
							<OrderInspector
								key={current.id}
								orderId={current.id}
								onAssign={(entityId) => assign(current, entityId)}
								onReimbursable={(value) => cycleReimbursable(current, value)}
								onFile={() => setReview(current, "filed")}
								onIgnore={() => setReview(current, "ignored")}
							/>
						) : (
							<div className="grid h-full place-items-center text-xs text-muted-foreground">
								{rows.length ? "Select an order" : ""}
							</div>
						)}
					</aside>
				)}
			</div>

			<KeyboardHints entities={activeEntities} />

			<ManualOrderDialog
				open={manualOpen}
				onOpenChange={setManualOpen}
				onCreated={(id) => {
					pendingFocus.current = id;
					setCurrentId(id);
				}}
			/>
		</div>
	);
}

function KeyboardHints({ entities }: { entities: EntityRow[] }) {
	return (
		<footer className="hidden shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-card px-3 py-1 text-[11px] text-muted-foreground md:flex">
			<Hint keys={["j", "k"]}>move</Hint>
			{entities.slice(0, 9).map((entity, index) => (
				<span key={entity.id} className="inline-flex items-center gap-1">
					<Kbd>{index + 1}</Kbd>
					<EntityDot color={entity.color} />
					{entity.shortName || entity.name}
				</span>
			))}
			<Hint keys={["0"]}>unassign</Hint>
			<Hint keys={["r"]}>reimbursable</Hint>
			<Hint keys={["e"]}>file</Hint>
			<Hint keys={["i"]}>ignore</Hint>
			<Hint keys={["x"]}>select</Hint>
			<Hint keys={["⇧E"]}>file selected</Hint>
			<Hint keys={["o"]}>open</Hint>
		</footer>
	);
}

function Hint({ keys, children }: { keys: string[]; children: string }) {
	return (
		<span className="inline-flex items-center gap-1">
			{keys.map((key) => (
				<Kbd key={key}>{key}</Kbd>
			))}
			{children}
		</span>
	);
}

function ListSkeleton() {
	return (
		<div aria-busy="true" className="flex flex-col">
			{Array.from({ length: 8 }, (_, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
					key={index}
					className="flex h-11 items-center gap-2 border-b border-border px-3"
				>
					<div className="h-3 w-10 animate-pulse rounded-sm bg-muted" />
					<div className="h-3 flex-1 animate-pulse rounded-sm bg-muted" />
					<div className="h-3 w-14 animate-pulse rounded-sm bg-muted" />
				</div>
			))}
		</div>
	);
}

function ReimbursementHint({ row }: { row: OrderListRow }) {
	const reimbursable = row.allocations.find((a) => a.reimbursable);
	if (reimbursable) {
		const tone =
			reimbursable.reimbursementStatus === "reimbursed"
				? "success"
				: reimbursable.reimbursementStatus === "submitted"
					? "info"
					: reimbursable.reimbursementStatus === "rejected"
						? "danger"
						: "warning";
		return (
			<Tag
				tone={tone}
				title={`Reimbursement ${reimbursable.reimbursementStatus}`}
			>
				reimb
			</Tag>
		);
	}
	if (row.reimbursableOverride === true)
		return (
			<Tag tone="warning" title="Forced reimbursable">
				reimb
			</Tag>
		);
	return null;
}

function InboxRow({
	row,
	current,
	checked,
	entity,
	onToggle,
	onClick,
}: {
	row: OrderListRow;
	current: boolean;
	checked: boolean;
	entity: Parameters<typeof EntityChip>[0]["entity"];
	onToggle: () => void;
	onClick: () => void;
}) {
	const split = new Set(row.allocations.map((a) => a.entityId)).size > 1;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled globally via hotkeys
		<div
			id={`inbox-row-${row.id}`}
			role="option"
			aria-selected={current}
			tabIndex={-1}
			onClick={onClick}
			className={cn(
				"group flex cursor-pointer gap-2 border-b border-l-2 border-b-border border-l-transparent px-2 py-1.5 hover:bg-accent/50",
				current && "border-l-primary bg-accent/70",
				checked && "bg-primary/5",
			)}
		>
			<input
				type="checkbox"
				aria-label={`Select order ${row.externalOrderId}`}
				checked={checked}
				onChange={onToggle}
				onClick={(event) => event.stopPropagation()}
				className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
			/>
			{row.firstItemImage ? (
				<img
					src={row.firstItemImage}
					alt=""
					loading="lazy"
					referrerPolicy="no-referrer"
					className="size-8 shrink-0 rounded-[3px] border border-border bg-muted object-cover"
				/>
			) : (
				<span className="size-8 shrink-0 rounded-[3px] border border-border bg-muted" />
			)}
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2 text-xs">
					<StoreMark
						source={row.source}
						className="shrink-0 [&>span:last-child]:hidden"
					/>
					<span className="truncate font-medium">
						{row.merchantName ?? "Unknown merchant"}
					</span>
					<span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:inline">
						{row.externalOrderId}
					</span>
					<Money
						minor={row.totalMinor}
						currency={row.currency}
						className="ml-auto shrink-0 text-xs font-semibold"
					/>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="min-w-0 flex-1 truncate">
						{row.firstItemTitle ?? "No items"}
						{row.itemCount > 1 && (
							<span className="ml-1 font-mono text-[10px]">
								+{row.itemCount - 1} item{row.itemCount > 2 ? "s" : ""}
							</span>
						)}
					</span>
					<ReimbursementHint row={row} />
					{split ? (
						<Tag tone="primary" title="Split across entities">
							split
						</Tag>
					) : (
						<EntityChip entity={entity} short className="max-w-28" />
					)}
					{row.documentCount > 0 ? (
						<IconFileInvoice
							className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
							aria-label="Has invoice"
						/>
					) : (
						<IconFileOff
							className="size-3.5 shrink-0 text-muted-foreground/60"
							aria-label="No invoice"
						/>
					)}
					<span
						className="w-14 shrink-0 text-right font-mono text-[10px]"
						title={`Captured ${new Date(row.lastCapturedAt).toLocaleString()}`}
					>
						{formatDate(row.orderDate)}
					</span>
					<span className="hidden w-14 shrink-0 text-right font-mono text-[10px] sm:inline">
						{formatRelative(row.firstSeenAt)}
					</span>
				</div>
			</div>
		</div>
	);
}
