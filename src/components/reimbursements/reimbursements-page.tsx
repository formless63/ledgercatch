import {
	IconAlertTriangle,
	IconArrowLeft,
	IconCheck,
	IconFileCheck,
	IconFileX,
	IconReceiptRefund,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDate, formatMoney } from "#/components/app/format";
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
	Select,
	StatTile,
	StoreMark,
	Tag,
	Textarea,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import {
	type EntityRow,
	ledgerKeys,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import {
	createClaim,
	getReimbursements,
	setClaimStatus,
	setReimbursementStatus,
} from "#/features/ledger/ledger.functions";
import { getClaimStats } from "#/features/ledger/review-ui.functions";
import { cn } from "#/lib/utils";
import { ClaimDrawer } from "./claim-drawer";
import { CLAIM_TONES, ClaimActions, type ClaimStatus } from "./claim-shared";

type ReimbursementData = Awaited<ReturnType<typeof getReimbursements>>;
type OpenRow = ReimbursementData["open"][number];
export type ClaimRow = ReimbursementData["claims"][number];

type Group = {
	key: string;
	owingEntityId: string;
	payerEntityId: string | null;
	currency: string;
	paymentLabels: string[];
	rows: OpenRow[];
	totalMinor: number;
};

function groupRows(rows: OpenRow[]) {
	const groups = new Map<string, Group>();
	for (const row of rows) {
		const key = row.payingEntityId
			? `${row.entityId}|${row.payingEntityId}|${row.currency}`
			: `unmapped|${row.currency}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				owingEntityId: row.entityId,
				payerEntityId: row.payingEntityId,
				currency: row.currency,
				paymentLabels: [],
				rows: [],
				totalMinor: 0,
			};
			groups.set(key, group);
		}
		group.rows.push(row);
		group.totalMinor += row.amountMinor;
		const label = row.paymentLabel ?? "No payment method";
		if (!group.paymentLabels.includes(label)) group.paymentLabels.push(label);
	}
	return [...groups.values()].sort((a, b) => b.totalMinor - a.totalMinor);
}

function sumByCurrency(
	items: Array<{ currency: string; amountMinor: number }>,
) {
	const totals = new Map<string, number>();
	for (const item of items)
		totals.set(
			item.currency,
			(totals.get(item.currency) ?? 0) + item.amountMinor,
		);
	return [...totals.entries()].map(([currency, amountMinor]) => ({
		currency,
		amountMinor,
	}));
}

function MoneyList({
	totals,
	className,
}: {
	totals: Array<{ currency: string; amountMinor: number }>;
	className?: string;
}) {
	if (totals.length === 0) return <span className={className}>—</span>;
	return (
		<span className={cn("flex flex-col", className)}>
			{totals.map((total) => (
				<Money
					key={total.currency}
					minor={total.amountMinor}
					currency={total.currency}
				/>
			))}
		</span>
	);
}

export function ReimbursementsPage({
	claimId,
	onClaimChange,
}: {
	claimId: string | null;
	onClaimChange: (claimId: string | null) => void;
}) {
	const { entityById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const query = useQuery({
		queryKey: ledgerKeys.reimbursements,
		queryFn: () => getReimbursements(),
	});
	const stats = useQuery({
		queryKey: [...ledgerKeys.reimbursements, "claim-stats"],
		queryFn: () => getClaimStats(),
	});
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [composing, setComposing] = useState(false);

	const open = query.data?.open ?? [];
	const unclaimed = useMemo(() => open.filter((row) => !row.claimId), [open]);
	const groups = useMemo(() => groupRows(unclaimed), [unclaimed]);
	const mapped = groups.filter((group) => group.payerEntityId);
	const unmapped = groups.filter((group) => !group.payerEntityId);
	const claims = query.data?.claims ?? [];
	const statsById = new Map(
		(stats.data ?? []).map((row) => [row.claimId, row]),
	);

	const selectedRows = unclaimed.filter((row) => selected.has(row.id));
	const selectedGroupCount = new Set(
		selectedRows.map(
			(row) => `${row.entityId}|${row.payingEntityId}|${row.currency}`,
		),
	).size;
	const selectedUnmapped = selectedRows.some((row) => !row.payingEntityId);

	const toggle = (ids: string[], on: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			for (const id of ids) {
				if (on) next.add(id);
				else next.delete(id);
			}
			return next;
		});

	const create = useMutation({
		mutationFn: (input: { reference?: string; notes?: string }) =>
			createClaim({
				data: { allocationIds: selectedRows.map((row) => row.id), ...input },
			}),
		onSuccess: (result) => {
			toast.success(
				`Created ${result.claimIds.length} claim${result.claimIds.length === 1 ? "" : "s"}`,
			);
			setSelected(new Set());
			setComposing(false);
			void invalidate();
			if (result.claimIds.length === 1 && result.claimIds[0])
				onClaimChange(result.claimIds[0]);
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const notReimbursable = useMutation({
		mutationFn: () =>
			setReimbursementStatus({
				data: {
					allocationIds: selectedRows.map((row) => row.id),
					status: "none",
				},
			}),
		onSuccess: (result) => {
			toast.success(`Marked ${result.updated} as not reimbursable`);
			setSelected(new Set());
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const pendingTotals = sumByCurrency(unclaimed);
	const submittedTotals = sumByCurrency(
		claims
			.filter((claim) => claim.status === "submitted")
			.map((claim) => ({
				currency: claim.currency,
				amountMinor: claim.totalMinor,
			})),
	);
	const missingInvoices = unclaimed.filter((row) => row.documentCount === 0);

	return (
		<div className="flex min-h-full flex-col">
			<PageHeader
				title="Reimbursements"
				description="Who owes whom: spend paid with one entity's card on behalf of another. Select orders and bundle them into claims."
			/>

			<div className="grid grid-cols-2 gap-2 px-4 pt-4 lg:grid-cols-4">
				<StatTile
					label="Unclaimed"
					tone={unclaimed.length ? "warning" : undefined}
					value={<MoneyList totals={pendingTotals} />}
					hint={`${unclaimed.length} allocation${unclaimed.length === 1 ? "" : "s"}`}
				/>
				<StatTile
					label="Awaiting payment"
					tone="primary"
					value={<MoneyList totals={submittedTotals} />}
					hint={`${claims.filter((c) => c.status === "submitted").length} submitted claims`}
				/>
				<StatTile
					label="Unmapped cards"
					tone={unmapped.length ? "danger" : undefined}
					value={unmapped.reduce((sum, group) => sum + group.rows.length, 0)}
					hint="orders without a paying entity"
				/>
				<StatTile
					label="Missing invoices"
					tone={missingInvoices.length ? "danger" : undefined}
					value={missingInvoices.length}
					hint="in unclaimed orders"
				/>
			</div>

			{selectedRows.length > 0 && (
				<div className="sticky top-0 z-10 mx-4 mt-3 flex flex-wrap items-center gap-2 rounded border border-primary/40 bg-card px-3 py-2 shadow-sm">
					<span className="text-xs">
						<span className="font-mono font-semibold tabular-nums">
							{selectedRows.length}
						</span>{" "}
						selected ·{" "}
					</span>
					<span className="flex flex-wrap gap-2 text-xs">
						{sumByCurrency(selectedRows).map((total) => (
							<Money
								key={total.currency}
								minor={total.amountMinor}
								currency={total.currency}
								className="font-semibold"
							/>
						))}
					</span>
					{selectedGroupCount > 1 && !selectedUnmapped && (
						<span className="text-[11px] text-muted-foreground">
							→ {selectedGroupCount} claims (one per payer/owing/currency)
						</span>
					)}
					<div className="ml-auto flex flex-wrap gap-1.5">
						<Button variant="ghost" onClick={() => setSelected(new Set())}>
							Clear
						</Button>
						<Button
							variant="ghost"
							disabled={notReimbursable.isPending}
							onClick={() => notReimbursable.mutate()}
						>
							Not reimbursable
						</Button>
						<Button
							variant="primary"
							disabled={selectedUnmapped}
							title={
								selectedUnmapped
									? "Map the payment method to a paying entity first"
									: undefined
							}
							onClick={() => setComposing(true)}
						>
							<IconReceiptRefund />
							Create claim
						</Button>
					</div>
					{composing && (
						<ClaimComposer
							pending={create.isPending}
							onCancel={() => setComposing(false)}
							onSubmit={(input) => create.mutate(input)}
						/>
					)}
				</div>
			)}

			<div className="flex flex-col gap-4 p-4">
				{query.isError ? (
					<EmptyState
						icon={<IconAlertTriangle className="size-6" />}
						title="Could not load reimbursements"
					>
						{errorMessage(query.error)}
					</EmptyState>
				) : query.isPending ? (
					<div className="text-xs text-muted-foreground">Loading…</div>
				) : (
					<>
						{unmapped.map((group) => (
							<GroupCard
								key={group.key}
								group={group}
								entityById={entityById}
								selected={selected}
								onToggle={toggle}
								warning
							/>
						))}
						{mapped.length === 0 && unmapped.length === 0 ? (
							<EmptyState
								icon={<IconCheck className="size-6" />}
								title="Nothing outstanding"
							>
								No unclaimed reimbursable spend. Orders paid with one entity's
								card for another entity show up here automatically.
							</EmptyState>
						) : (
							mapped.map((group) => (
								<GroupCard
									key={group.key}
									group={group}
									entityById={entityById}
									selected={selected}
									onToggle={toggle}
								/>
							))
						)}
						<ClaimsTable
							claims={claims}
							entityById={entityById}
							statsById={statsById}
							onOpen={onClaimChange}
						/>
					</>
				)}
			</div>

			<ClaimDrawer claimId={claimId} onClose={() => onClaimChange(null)} />
		</div>
	);
}

function ClaimComposer({
	pending,
	onCancel,
	onSubmit,
}: {
	pending: boolean;
	onCancel: () => void;
	onSubmit: (input: { reference?: string; notes?: string }) => void;
}) {
	const [reference, setReference] = useState("");
	const [notes, setNotes] = useState("");
	return (
		<form
			className="flex w-full flex-col gap-2 border-t border-border pt-2 sm:flex-row sm:items-end"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit({
					reference: reference.trim() || undefined,
					notes: notes.trim() || undefined,
				});
			}}
		>
			<Field label="Reference (optional)" className="sm:w-48">
				<Input
					value={reference}
					maxLength={120}
					placeholder="EXP-2026-10"
					onChange={(event) => setReference(event.target.value)}
				/>
			</Field>
			<Field label="Notes (optional)" className="flex-1">
				<Textarea
					value={notes}
					maxLength={2000}
					rows={1}
					className="min-h-6"
					onChange={(event) => setNotes(event.target.value)}
				/>
			</Field>
			<div className="flex gap-1.5">
				<Button variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" variant="primary" disabled={pending}>
					Submit claim
				</Button>
			</div>
		</form>
	);
}

function GroupCard({
	group,
	entityById,
	selected,
	onToggle,
	warning,
}: {
	group: Group;
	entityById: Map<string, EntityRow>;
	selected: Set<string>;
	onToggle: (ids: string[], on: boolean) => void;
	warning?: boolean;
}) {
	const ids = group.rows.map((row) => row.id);
	const selectedCount = ids.filter((id) => selected.has(id)).length;
	const allSelected = selectedCount === ids.length;
	const owing = entityById.get(group.owingEntityId);
	const payer = group.payerEntityId
		? entityById.get(group.payerEntityId)
		: null;
	return (
		<section
			aria-label={
				warning
					? `Unmapped payment methods, ${group.currency}`
					: `${owing?.name ?? "Entity"} owes ${payer?.name ?? "payer"}, ${group.currency}`
			}
			className={cn(
				"rounded border bg-card",
				warning ? "border-amber-500/50" : "border-border",
			)}
		>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2">
				<input
					type="checkbox"
					aria-label="Select all in group"
					checked={allSelected}
					ref={(el) => {
						if (el) el.indeterminate = selectedCount > 0 && !allSelected;
					}}
					onChange={(event) => onToggle(ids, event.target.checked)}
					className="size-3.5 accent-[var(--primary)]"
				/>
				{warning ? (
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs">
						<IconAlertTriangle className="size-4 text-amber-500" />
						<span className="font-semibold">No paying entity</span>
						<span className="text-muted-foreground">
							Paid with {group.paymentLabels.join(", ")}.{" "}
							<Link
								to="/app/settings"
								className="text-primary underline-offset-2 hover:underline"
							>
								Map the card to an entity
							</Link>{" "}
							to claim these.
						</span>
					</div>
				) : (
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
						<EntityChip entity={owing} />
						<span className="text-muted-foreground">owes</span>
						<EntityChip entity={payer} />
						<span className="truncate text-[11px] text-muted-foreground">
							via {group.paymentLabels.join(", ")}
						</span>
					</div>
				)}
				<div className="flex items-baseline gap-2">
					<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
						{group.rows.length} order{group.rows.length === 1 ? "" : "s"}
					</span>
					<Money
						minor={group.totalMinor}
						currency={group.currency}
						className="text-sm font-semibold"
					/>
				</div>
			</header>
			<div className="overflow-x-auto">
				<table className="w-full min-w-[560px] text-xs">
					<caption className="sr-only">Unclaimed orders</caption>
					<thead>
						<tr className="h-6 border-b border-border text-left">
							<th scope="col" className="w-8 px-3">
								<span className="sr-only">Select</span>
							</th>
							<th scope="col" className="label-caps px-2">
								Date
							</th>
							<th scope="col" className="label-caps px-2">
								Store
							</th>
							<th scope="col" className="label-caps px-2">
								Merchant / order
							</th>
							{warning && (
								<th scope="col" className="label-caps px-2">
									Owing
								</th>
							)}
							<th scope="col" className="label-caps px-2">
								Status
							</th>
							<th scope="col" className="label-caps px-2 text-center">
								Inv
							</th>
							<th scope="col" className="label-caps px-2 text-right">
								Amount
							</th>
						</tr>
					</thead>
					<tbody>
						{group.rows.map((row) => (
							<tr
								key={row.id}
								className={cn(
									"h-7 border-b border-border last:border-0 hover:bg-accent/40",
									selected.has(row.id) && "bg-primary/5",
								)}
							>
								<td className="px-3">
									<input
										type="checkbox"
										aria-label={`Select order ${row.externalOrderId ?? row.orderId.slice(0, 8)}`}
										checked={selected.has(row.id)}
										onChange={(event) =>
											onToggle([row.id], event.target.checked)
										}
										className="size-3.5 accent-[var(--primary)]"
									/>
								</td>
								<td className="whitespace-nowrap px-2 font-mono tabular-nums text-muted-foreground">
									{formatDate(row.orderDate)}
								</td>
								<td className="whitespace-nowrap px-2">
									<StoreMark source={row.source} />
								</td>
								<td className="max-w-[18rem] px-2">
									<Link
										to="/app/orders/$orderId"
										params={{ orderId: row.orderId }}
										className="block truncate hover:underline"
									>
										{row.merchantName ?? "—"}
										<span className="ml-2 font-mono text-[11px] text-muted-foreground">
											{row.externalOrderId ?? row.orderId.slice(0, 8)}
										</span>
									</Link>
								</td>
								{warning && (
									<td className="px-2">
										<EntityChip entity={entityById.get(row.entityId)} short />
									</td>
								)}
								<td className="whitespace-nowrap px-2">
									<ReimbursementTag status={row.reimbursementStatus} />
								</td>
								<td className="px-2 text-center">
									{row.documentCount > 0 ? (
										<IconFileCheck
											className="inline size-3.5 text-emerald-500"
											aria-label="Invoice attached"
										/>
									) : (
										<IconFileX
											className="inline size-3.5 text-red-500"
											aria-label="Invoice missing"
										/>
									)}
								</td>
								<td className="whitespace-nowrap px-2 text-right">
									<Money minor={row.amountMinor} currency={row.currency} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}

function ClaimsTable({
	claims,
	entityById,
	statsById,
	onOpen,
}: {
	claims: ClaimRow[];
	entityById: Map<string, EntityRow>;
	statsById: Map<string, { lines: number; missingInvoices: number }>;
	onOpen: (id: string) => void;
}) {
	const invalidate = useInvalidateLedger();
	const [filter, setFilter] = useState<"open" | "all" | ClaimStatus>("open");
	const setStatus = useMutation({
		mutationFn: (input: { id: string; status: ClaimStatus }) =>
			setClaimStatus({ data: input }),
		onSuccess: (_result, input) => {
			toast.success(
				input.status === "paid"
					? "Claim marked paid"
					: input.status === "void"
						? "Claim voided; its orders are unclaimed again"
						: "Claim reopened",
			);
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const visible = claims.filter((claim) =>
		filter === "all"
			? true
			: filter === "open"
				? claim.status === "draft" || claim.status === "submitted"
				: claim.status === filter,
	);
	return (
		<Panel
			title={`Claims (${claims.length})`}
			bodyClassName="p-0"
			action={
				// biome-ignore lint/a11y/noLabelWithoutControl: wraps its Select
				<label className="flex items-center gap-1.5">
					<span className="sr-only">Filter claims</span>
					<Select
						className="h-5 w-28 text-[11px]"
						value={filter}
						onChange={(event) => setFilter(event.target.value as typeof filter)}
					>
						<option value="open">Open</option>
						<option value="all">All</option>
						<option value="draft">Draft</option>
						<option value="submitted">Submitted</option>
						<option value="paid">Paid</option>
						<option value="void">Void</option>
					</Select>
				</label>
			}
		>
			{visible.length === 0 ? (
				<p className="p-3 text-xs text-muted-foreground">
					No {filter === "all" ? "" : filter} claims.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[640px] text-xs">
						<caption className="sr-only">Claims</caption>
						<thead>
							<tr className="h-6 border-b border-border text-left">
								<th scope="col" className="label-caps px-3">
									Created
								</th>
								<th scope="col" className="label-caps px-2">
									Owing → payer
								</th>
								<th scope="col" className="label-caps px-2">
									Reference
								</th>
								<th scope="col" className="label-caps px-2">
									Status
								</th>
								<th scope="col" className="label-caps px-2 text-right">
									Lines
								</th>
								<th scope="col" className="label-caps px-2 text-right">
									Total
								</th>
								<th scope="col" className="px-2">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{visible.map((claim) => {
								const stat = statsById.get(claim.id);
								return (
									<tr
										key={claim.id}
										className="h-8 border-b border-border last:border-0 hover:bg-accent/40"
									>
										<td className="whitespace-nowrap px-3 font-mono tabular-nums text-muted-foreground">
											<button
												type="button"
												className="hover:text-foreground hover:underline"
												onClick={() => onOpen(claim.id)}
											>
												{formatDate(claim.createdAt)}
											</button>
										</td>
										<td className="px-2">
											<button
												type="button"
												onClick={() => onOpen(claim.id)}
												className="flex items-center gap-1.5"
												aria-label={`Open claim ${claim.reference ?? claim.id.slice(0, 8)}`}
											>
												<EntityChip
													entity={entityById.get(claim.owingEntityId)}
													short
												/>
												<IconArrowLeft className="size-3 rotate-180 text-muted-foreground" />
												<EntityChip
													entity={entityById.get(claim.payerEntityId)}
													short
												/>
											</button>
										</td>
										<td className="max-w-[10rem] truncate px-2 font-mono text-[11px]">
											{claim.reference ?? "—"}
										</td>
										<td className="whitespace-nowrap px-2">
											<Tag tone={CLAIM_TONES[claim.status] ?? "neutral"}>
												{claim.status}
											</Tag>
											<span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
												{claim.status === "paid"
													? formatDate(claim.paidAt)
													: claim.submittedAt
														? formatDate(claim.submittedAt)
														: ""}
											</span>
										</td>
										<td className="px-2 text-right font-mono tabular-nums">
											{stat?.lines ?? "—"}
											{stat && stat.missingInvoices > 0 && (
												<span
													className="ml-1 text-red-500"
													title={`${stat.missingInvoices} without invoice`}
												>
													·{stat.missingInvoices}
												</span>
											)}
										</td>
										<td className="whitespace-nowrap px-2 text-right">
											<Money
												minor={claim.totalMinor}
												currency={claim.currency}
												className="font-semibold"
											/>
										</td>
										<td className="whitespace-nowrap px-2 text-right">
											<ClaimActions
												status={claim.status}
												disabled={setStatus.isPending}
												onStatus={(status) =>
													setStatus.mutate({ id: claim.id, status })
												}
											/>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
			{visible.length > 0 && (
				<p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
					Totals are per claim currency:{" "}
					{sumByCurrency(
						visible
							.filter((claim) => claim.status !== "void")
							.map((claim) => ({
								currency: claim.currency,
								amountMinor: claim.totalMinor,
							})),
					)
						.map((total) => formatMoney(total.amountMinor, total.currency))
						.join(" · ") || "—"}
				</p>
			)}
		</Panel>
	);
}
