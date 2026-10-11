/** Order detail sections shared by the Inbox inspector and the detail page. */
import {
	IconAdjustmentsBolt,
	IconExternalLink,
	IconPhoto,
	IconRefresh,
	IconSend,
	IconTruckDelivery,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import {
	CAPTURE_STATUS_TONES,
	formatDate,
	formatRelative,
	type Tone,
} from "#/components/app/format";
import {
	AllocationBar,
	Button,
	EntityChip,
	Money,
	ReimbursementTag,
	Select,
	Tag,
} from "#/components/app/primitives";
import { RegisterAssetButton } from "#/components/lifecycle/asset-dialog";
import { TrackingLink } from "#/components/lifecycle/tracking-link";
import {
	ledgerKeys,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import {
	explainRules,
	listConnections,
	listRules,
	setReimbursementStatus,
} from "#/features/ledger/ledger.functions";
import type { OrderDetail } from "#/features/ledger/ledger.server";
import { cn } from "#/lib/utils";
import {
	CategorySelect,
	categoryLabel,
	describeHistoryMetadata,
	EntitySelect,
	errorMessage,
	humanizeAction,
	paymentMethodLabel,
	useOrderActions,
} from "./shared";

/* ───────────────────────── line items ───────────────────────── */

export function ItemsTable({
	detail,
	editable,
}: {
	detail: OrderDetail;
	editable?: boolean;
}) {
	const { activeEntities, activeCategories, entityById, categoryById } =
		useBootstrap();
	const { updateItem } = useOrderActions();
	const { order, items } = detail;
	if (items.length === 0)
		return (
			<p className="px-3 py-3 text-xs text-muted-foreground">
				No line items captured.
			</p>
		);
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[520px] border-collapse text-xs">
				<thead>
					<tr className="h-7 border-b border-border text-left">
						<th className="label-caps w-9 px-2 font-semibold">
							<span className="sr-only">Image</span>
						</th>
						<th className="label-caps px-2">Item</th>
						<th className="label-caps w-12 px-2 text-right">Qty</th>
						<th className="label-caps w-24 px-2 text-right">Unit</th>
						<th className="label-caps w-24 px-2 text-right">Total</th>
						<th className="label-caps w-40 px-2">Entity</th>
						{editable && <th className="label-caps w-44 px-2">Category</th>}
						{editable && <th className="w-16" />}
					</tr>
				</thead>
				<tbody>
					{items.map((item) => {
						const entity = entityById.get(
							item.entityId ?? order.entityId ?? "",
						);
						return (
							<tr
								key={item.id}
								className="border-b border-border/60 align-middle last:border-0 hover:bg-accent/40"
							>
								<td className="px-2 py-1">
									{item.imageUrl ? (
										<img
											src={item.imageUrl}
											alt=""
											loading="lazy"
											referrerPolicy="no-referrer"
											className="size-7 rounded-[3px] border border-border bg-muted object-cover"
										/>
									) : (
										<span className="grid size-7 place-items-center rounded-[3px] border border-border bg-muted text-muted-foreground">
											<IconPhoto className="size-3.5" />
										</span>
									)}
								</td>
								<td className="max-w-0 px-2 py-1">
									<div className="truncate" title={item.title}>
										{item.itemUrl ? (
											<a
												href={item.itemUrl}
												target="_blank"
												rel="noreferrer"
												className="hover:underline"
											>
												{item.title}
											</a>
										) : (
											item.title
										)}
									</div>
									{(item.sku || item.variant) && (
										<div className="truncate font-mono text-[10px] text-muted-foreground">
											{[item.sku, item.variant].filter(Boolean).join(" · ")}
										</div>
									)}
								</td>
								<td className="px-2 py-1 text-right font-mono tabular-nums">
									{item.quantity}
								</td>
								<td className="px-2 py-1 text-right">
									<Money
										minor={item.unitPriceMinor}
										currency={order.currency}
									/>
								</td>
								<td className="px-2 py-1 text-right">
									<Money minor={item.totalMinor} currency={order.currency} />
								</td>
								<td className="px-2 py-1">
									{editable ? (
										<EntitySelect
											label={`Entity for ${item.title}`}
											value={item.entityId}
											entities={activeEntities}
											placeholder={
												order.entityId
													? `↳ ${entityById.get(order.entityId)?.name ?? "Order entity"}`
													: "↳ Order entity"
											}
											onChange={(entityId) =>
												updateItem.mutate({ itemId: item.id, entityId })
											}
										/>
									) : (
										<span className="flex items-center gap-1">
											<EntityChip entity={entity} short />
											{item.entityId && (
												<span
													className="font-mono text-[9px] text-muted-foreground"
													title="Per-item override"
												>
													OVR
												</span>
											)}
										</span>
									)}
								</td>
								{editable && (
									<td className="px-2 py-1">
										<CategorySelect
											label={`Category for ${item.title}`}
											value={item.categoryId}
											categories={activeCategories}
											entityId={item.entityId ?? order.entityId}
											placeholder={
												order.categoryId
													? `↳ ${categoryById.get(order.categoryId)?.name ?? "Order category"}`
													: "↳ Order category"
											}
											onChange={(categoryId) =>
												updateItem.mutate({ itemId: item.id, categoryId })
											}
										/>
									</td>
								)}
								{editable && (
									<td className="px-2 py-1 text-right">
										<RegisterAssetButton detail={detail} item={item} />
									</td>
								)}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/* ───────────────────────── totals ───────────────────────── */

export function TotalsBreakdown({
	detail,
	className,
}: {
	detail: OrderDetail;
	className?: string;
}) {
	const { order, items } = detail;
	const itemSum = items.reduce((sum, item) => sum + (item.totalMinor ?? 0), 0);
	const rows: Array<[string, number | null, string?]> = [
		["Subtotal", order.subtotalMinor],
		["Shipping", order.shippingMinor],
		["Tax", order.taxMinor],
		[
			"Discount",
			order.discountMinor == null ? null : -Math.abs(order.discountMinor),
		],
	];
	const mismatch =
		items.length > 0 &&
		order.subtotalMinor != null &&
		items.every((item) => item.totalMinor != null) &&
		itemSum !== order.subtotalMinor;
	return (
		<dl
			className={cn(
				"grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-xs",
				className,
			)}
		>
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="text-right">
						<Money
							minor={value}
							currency={order.currency}
							muted={value == null}
						/>
					</dd>
				</div>
			))}
			<dt className="border-t border-border pt-1 font-semibold">Total</dt>
			<dd className="border-t border-border pt-1 text-right font-semibold">
				<Money minor={order.totalMinor} currency={order.currency} />
			</dd>
			{mismatch && (
				<dd className="col-span-2 pt-1 text-[11px] text-amber-600 dark:text-amber-400">
					Items sum to <Money minor={itemSum} currency={order.currency} /> —
					differs from subtotal.
				</dd>
			)}
		</dl>
	);
}

/* ───────────────────────── allocation ───────────────────────── */

const REIMBURSEMENT_OPTIONS = [
	["none", "Not reimbursable"],
	["pending", "Pending claim"],
	["submitted", "Claim submitted"],
	["reimbursed", "Reimbursed"],
	["rejected", "Rejected"],
] as const;

export function AllocationSection({
	detail,
	editable,
}: {
	detail: OrderDetail;
	editable?: boolean;
}) {
	const { entityById, categoryById, paymentMethodById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const status = useMutation({
		mutationFn: (input: {
			allocationIds: string[];
			status: (typeof REIMBURSEMENT_OPTIONS)[number][0];
		}) => setReimbursementStatus({ data: input }),
		onSuccess: () => toast.success("Reimbursement status updated"),
		onError: (error) => toast.error(errorMessage(error)),
		onSettled: () => void invalidate(),
	});
	const { order, allocations } = detail;
	const method = order.paymentMethodId
		? paymentMethodById.get(order.paymentMethodId)
		: undefined;
	const payer = method?.payingEntityId
		? entityById.get(method.payingEntityId)
		: undefined;
	if (allocations.length === 0)
		return (
			<p className="text-xs text-muted-foreground">
				Not allocated — assign an entity to split this order.
			</p>
		);
	const total = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
	return (
		<div className="flex flex-col gap-2">
			<AllocationBar
				parts={allocations.map((a) => {
					const entity = entityById.get(a.entityId);
					return {
						color: entity?.color ?? "sky",
						amount: a.amountMinor,
						label: entity?.name,
					};
				})}
			/>
			<ul className="flex flex-col gap-1">
				{allocations.map((allocation) => {
					const entity = entityById.get(allocation.entityId);
					const category = allocation.categoryId
						? categoryById.get(allocation.categoryId)
						: undefined;
					const share = total
						? Math.round((allocation.amountMinor / total) * 100)
						: 0;
					return (
						<li
							key={allocation.id}
							className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
						>
							<EntityChip entity={entity} />
							<Money
								minor={allocation.amountMinor}
								currency={allocation.currency}
							/>
							<span className="font-mono text-[10px] text-muted-foreground">
								{share}%
							</span>
							{category && (
								<span className="truncate text-[11px] text-muted-foreground">
									{categoryLabel(category)}
								</span>
							)}
							<span className="ml-auto flex items-center gap-1.5">
								{allocation.reimbursable ? (
									<>
										{payer && (
											<span className="hidden text-[10px] text-muted-foreground sm:inline">
												owes {payer.shortName || payer.name}
											</span>
										)}
										{editable ? (
											<Select
												aria-label={`Reimbursement status for ${entity?.name ?? "entity"}`}
												value={allocation.reimbursementStatus}
												className="h-5 w-auto text-[11px]"
												onChange={(event) =>
													status.mutate({
														allocationIds: [allocation.id],
														status: event.target
															.value as (typeof REIMBURSEMENT_OPTIONS)[number][0],
													})
												}
											>
												{REIMBURSEMENT_OPTIONS.map(([value, label]) => (
													<option key={value} value={value}>
														{label}
													</option>
												))}
											</Select>
										) : (
											<ReimbursementTag
												status={allocation.reimbursementStatus}
											/>
										)}
									</>
								) : (
									<>
										<ReimbursementTag status="none" />
										{editable && (
											<Button
												size="xs"
												variant="ghost"
												onClick={() =>
													status.mutate({
														allocationIds: [allocation.id],
														status: "pending",
													})
												}
											>
												Mark reimbursable
											</Button>
										)}
									</>
								)}
							</span>
						</li>
					);
				})}
			</ul>
			{method && !payer && (
				<p className="text-[11px] text-amber-600 dark:text-amber-400">
					{paymentMethodLabel(method)} has no paying entity, so reimbursement
					can't be derived.{" "}
					<Link to="/app/settings" className="underline underline-offset-2">
						Map it in settings
					</Link>
				</p>
			)}
		</div>
	);
}

/* ───────────────────────── shipments ───────────────────────── */

export function ShipmentsList({ detail }: { detail: OrderDetail }) {
	if (detail.shipments.length === 0)
		return (
			<p className="text-xs text-muted-foreground">No shipments recorded.</p>
		);
	return (
		<ul className="flex flex-col gap-1.5">
			{detail.shipments.map((shipment) => (
				<li
					key={shipment.id}
					className="flex flex-wrap items-center gap-2 text-xs"
				>
					<IconTruckDelivery className="size-3.5 text-muted-foreground" />
					<TrackingLink
						carrier={shipment.carrier}
						trackingNumber={shipment.trackingNumber}
					/>
					{shipment.status && <Tag tone="info">{shipment.status}</Tag>}
					<span className="ml-auto font-mono text-[10px] text-muted-foreground">
						{shipment.deliveredAt
							? `delivered ${shipment.deliveredAt}`
							: shipment.etaText
								? `eta ${shipment.etaText}`
								: shipment.shippedAt
									? `shipped ${shipment.shippedAt}`
									: ""}
					</span>
				</li>
			))}
		</ul>
	);
}

/* ───────────────────────── exports ───────────────────────── */

const EXPORT_TONES: Record<string, Tone> = {
	queued: "primary",
	sending: "primary",
	sent: "success",
	failed: "danger",
	skipped: "neutral",
};

export function ExportsSection({ detail }: { detail: OrderDetail }) {
	const { entityById } = useBootstrap();
	const { exportOrders } = useOrderActions();
	const connections = useQuery({
		queryKey: ledgerKeys.connections,
		queryFn: () => listConnections(),
	});
	const { order, allocations, exports } = detail;
	if (allocations.length === 0)
		return (
			<p className="text-xs text-muted-foreground">
				Nothing to export until the order is allocated to an entity.
			</p>
		);
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<Button
					size="xs"
					variant="primary"
					disabled={exportOrders.isPending}
					onClick={() => exportOrders.mutate({ orderIds: [order.id] })}
				>
					<IconSend />
					Export
				</Button>
				<Link
					to="/app/settings/connections"
					className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
				>
					Connections
				</Link>
			</div>
			<ul className="flex flex-col gap-2">
				{allocations.map((allocation) => {
					const entity = entityById.get(allocation.entityId);
					const rows = exports.filter((e) => e.allocationId === allocation.id);
					const seen = new Set(rows.map((row) => row.connectionId));
					const unexported = (connections.data ?? []).filter(
						(c) => c.entityId === allocation.entityId && !seen.has(c.id),
					);
					return (
						<li key={allocation.id} className="flex flex-col gap-1">
							<div className="flex items-center gap-2 text-xs">
								<EntityChip entity={entity} short />
								<Money
									minor={allocation.amountMinor}
									currency={allocation.currency}
								/>
							</div>
							{rows.length === 0 && unexported.length === 0 && (
								<p className="pl-2 text-[11px] text-muted-foreground">
									No accounting connection for this entity.
								</p>
							)}
							{rows.map((row) => (
								<div
									key={row.id}
									className="flex flex-wrap items-center gap-2 pl-2 text-xs"
								>
									<span className="truncate">{row.connectionName}</span>
									<span className="font-mono text-[10px] text-muted-foreground">
										{row.provider}
									</span>
									<Tag tone={EXPORT_TONES[row.status] ?? "neutral"}>
										{row.status}
									</Tag>
									{row.remoteUrl ? (
										<a
											href={row.remoteUrl}
											target="_blank"
											rel="noreferrer"
											className="inline-flex items-center gap-0.5 font-mono text-[10px] hover:underline"
										>
											{row.remoteId ?? "remote"}
											<IconExternalLink className="size-3" />
										</a>
									) : (
										row.remoteId && (
											<span className="font-mono text-[10px]">
												{row.remoteId}
											</span>
										)
									)}
									{row.sentAt && (
										<span className="font-mono text-[10px] text-muted-foreground">
											{formatRelative(row.sentAt)}
										</span>
									)}
									{(row.status === "skipped" ||
										row.status === "sent" ||
										row.status === "failed") && (
										<Button
											size="xs"
											variant="ghost"
											className="ml-auto"
											title="Push again, bypassing duplicate checks"
											disabled={exportOrders.isPending}
											onClick={() =>
												exportOrders.mutate({
													allocationIds: [allocation.id],
													connectionId: row.connectionId,
													force: true,
												})
											}
										>
											<IconRefresh />
											Force re-push
										</Button>
									)}
									{row.error && (
										<p className="w-full text-[11px] text-red-600 dark:text-red-400">
											{row.error}
										</p>
									)}
								</div>
							))}
							{unexported.map((connection) => (
								<div
									key={connection.id}
									className="flex items-center gap-2 pl-2 text-xs text-muted-foreground"
								>
									<span className="truncate">{connection.name}</span>
									<Tag>not exported</Tag>
								</div>
							))}
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/* ───────────────────────── provenance ───────────────────────── */

export function CapturesList({ detail }: { detail: OrderDetail }) {
	if (detail.captures.length === 0)
		return (
			<p className="text-xs text-muted-foreground">
				No captures — this order was entered manually.
			</p>
		);
	return (
		<ul className="flex flex-col gap-1">
			{detail.captures.map((capture) => (
				<li
					key={capture.id}
					className="flex flex-wrap items-center gap-2 text-xs"
				>
					<Tag tone={CAPTURE_STATUS_TONES[capture.status] ?? "neutral"}>
						{capture.status.replace("_", " ")}
					</Tag>
					<a
						href={`/app/captures?capture=${capture.id}`}
						className="font-mono hover:underline"
						title="Open in Captures"
					>
						{capture.kind}
						{capture.pageType ? ` · ${capture.pageType}` : ""}
					</a>
					<span className="text-[10px] text-muted-foreground">
						{capture.trigger}
					</span>
					{capture.parserId && (
						<span className="font-mono text-[10px] text-muted-foreground">
							{capture.parserId}
						</span>
					)}
					{capture.screenshotDocumentId && (
						<a
							href={`/api/documents/${capture.screenshotDocumentId}`}
							target="_blank"
							rel="noreferrer"
							className="text-[10px] text-muted-foreground hover:underline"
						>
							screenshot
						</a>
					)}
					<span className="ml-auto font-mono text-[10px] text-muted-foreground">
						{formatRelative(capture.capturedAt)}
					</span>
					{capture.error && (
						<p className="w-full truncate text-[11px] text-red-600 dark:text-red-400">
							{capture.error}
						</p>
					)}
				</li>
			))}
		</ul>
	);
}

export function HistoryTimeline({ detail }: { detail: OrderDetail }) {
	const { entityById, categoryById, paymentMethodById } = useBootstrap();
	if (detail.history.length === 0)
		return <p className="text-xs text-muted-foreground">No history yet.</p>;
	const lookups = {
		entityName: (id: string) => entityById.get(id)?.name,
		categoryName: (id: string) => categoryById.get(id)?.name,
		paymentName: (id: string) => {
			const method = paymentMethodById.get(id);
			return method ? paymentMethodLabel(method) : undefined;
		},
	};
	return (
		<ol className="relative flex flex-col gap-2 border-l border-border pl-3">
			{detail.history.map((event) => {
				const summary = describeHistoryMetadata(
					event.action,
					event.metadata,
					lookups,
				);
				return (
					<li key={event.id} className="relative text-xs">
						<span
							className={cn(
								"absolute -left-[16.5px] top-1 size-2 rounded-full border border-background",
								event.actorType === "user"
									? "bg-primary"
									: "bg-muted-foreground",
							)}
						/>
						<div className="flex flex-wrap items-baseline gap-x-2">
							<span className="font-medium">
								{humanizeAction(event.action)}
							</span>
							<span className="font-mono text-[10px] text-muted-foreground">
								{event.actorType === "user" ? "you" : event.actorId}
							</span>
							<time
								dateTime={event.createdAt}
								title={new Date(event.createdAt).toLocaleString()}
								className="ml-auto font-mono text-[10px] text-muted-foreground"
							>
								{formatRelative(event.createdAt)}
							</time>
						</div>
						{summary && (
							<div
								className="truncate text-[11px] text-muted-foreground"
								title={summary}
							>
								{summary}
							</div>
						)}
					</li>
				);
			})}
		</ol>
	);
}

/* ───────────────────────── rules hint ───────────────────────── */

export function RulesHint({ detail }: { detail: OrderDetail }) {
	const { entityById, categoryById } = useBootstrap();
	const { order } = detail;
	const explanation = useQuery({
		queryKey: [...ledgerKeys.order(order.id), "explain"],
		queryFn: () => explainRules({ data: { id: order.id } }),
		staleTime: 30_000,
	});
	const rules = useQuery({
		queryKey: ledgerKeys.rules,
		queryFn: () => listRules(),
		staleTime: 60_000,
	});
	const ruleName = (id: string) =>
		rules.data?.find((rule) => rule.id === id)?.name ?? "a rule";
	const matched = explanation.data?.matchedRuleIds ?? [];
	const actions = explanation.data?.actions;
	const parts: string[] = [];
	if (actions?.entityId)
		parts.push(`entity → ${entityById.get(actions.entityId)?.name ?? "?"}`);
	if (actions?.categoryId)
		parts.push(
			`category → ${categoryById.get(actions.categoryId)?.name ?? "?"}`,
		);
	if (actions?.reimbursable)
		parts.push(`reimbursable → ${actions.reimbursable}`);
	if (actions?.file) parts.push("auto-file");
	if (actions?.tags?.length) parts.push(`tags → ${actions.tags.join(", ")}`);
	return (
		<div className="flex items-start gap-2 rounded-sm border border-border bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
			<IconAdjustmentsBolt className="mt-0.5 size-3.5 shrink-0" />
			<div className="min-w-0 flex-1">
				{order.ruleId && (
					<div>
						Auto-assigned by{" "}
						<span className="text-foreground">{ruleName(order.ruleId)}</span>.
					</div>
				)}
				{explanation.isPending ? (
					<div>Checking rules…</div>
				) : matched.length ? (
					<div>
						Matches {matched.map(ruleName).join(", ")}
						{parts.length ? `: ${parts.join(" · ")}` : ""}.
					</div>
				) : (
					<div>
						No rule matches this order.{" "}
						<Link
							to="/app/rules"
							className="underline underline-offset-2 hover:text-foreground"
						>
							Create one
						</Link>{" "}
						to triage {order.merchantName ?? "this store"} automatically.
					</div>
				)}
			</div>
		</div>
	);
}

/* ───────────────────────── header bits ───────────────────────── */

export function OrderDateLine({ detail }: { detail: OrderDetail }) {
	const { order } = detail;
	return (
		<span className="font-mono text-[11px] text-muted-foreground">
			{formatDate(order.orderDate, "long")} · first seen{" "}
			{formatRelative(order.firstSeenAt)}
		</span>
	);
}
