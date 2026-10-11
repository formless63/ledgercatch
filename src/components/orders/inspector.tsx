/** Inbox inspector: compact, actionable view of one order. */
import {
	IconArchive,
	IconArrowUpRight,
	IconCheck,
	IconExternalLink,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDate, ORDER_STATUS_TONES } from "#/components/app/format";
import {
	Button,
	EntityChip,
	Kbd,
	Money,
	Panel,
	SectionLabel,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { DuplicateHint } from "#/components/lifecycle/duplicate-hint";
import { ledgerKeys, useBootstrap } from "#/features/ledger/hooks";
import { getOrder } from "#/features/ledger/ledger.functions";
import { cn } from "#/lib/utils";
import { DocumentsPanel } from "./documents";
import {
	AllocationSection,
	ItemsTable,
	RulesHint,
	ShipmentsList,
	TotalsBreakdown,
} from "./sections";
import {
	CategorySelect,
	PaymentMethodSelect,
	PaymentSummary,
	ReviewTag,
	useOrderActions,
} from "./shared";

export function useOrderDetail(orderId: string | null | undefined) {
	return useQuery({
		queryKey: ledgerKeys.order(orderId ?? "none"),
		queryFn: () => getOrder({ data: { id: orderId as string } }),
		enabled: Boolean(orderId),
	});
}

const REIMB_OPTIONS: Array<[boolean | null, string]> = [
	[null, "Auto"],
	[true, "Yes"],
	[false, "No"],
];

export function OrderInspector({
	orderId,
	onAssign,
	onReimbursable,
	onFile,
	onIgnore,
}: {
	orderId: string;
	onAssign: (entityId: string | null) => void;
	onReimbursable: (value: boolean | null) => void;
	onFile: () => void;
	onIgnore: () => void;
}) {
	const detail = useOrderDetail(orderId);
	const { activeEntities, activeCategories, data } = useBootstrap();
	const { update } = useOrderActions();

	if (detail.isPending)
		return (
			<div className="flex flex-col gap-3 p-4" aria-busy="true">
				<div className="h-5 w-1/2 animate-pulse rounded-sm bg-muted" />
				<div className="h-3 w-1/3 animate-pulse rounded-sm bg-muted" />
				<div className="h-32 animate-pulse rounded-sm bg-muted" />
			</div>
		);
	if (detail.isError || !detail.data)
		return (
			<p className="p-4 text-xs text-red-600 dark:text-red-400">
				Could not load this order.
			</p>
		);
	const { order } = detail.data;

	return (
		<div className="flex flex-col gap-3 p-3">
			<header className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<StoreMark source={order.source} />
						<Tag tone={ORDER_STATUS_TONES[order.status] ?? "neutral"}>
							{order.statusText || order.status}
						</Tag>
						{order.placedByGroup && (
							<span className="text-[11px] text-muted-foreground">
								Placed by group: {order.placedByGroup}
							</span>
						)}
						<ReviewTag state={order.reviewState} />
					</div>
					<h2 className="mt-1 truncate text-base font-semibold">
						{order.merchantName ?? "Unknown merchant"}
					</h2>
					<div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
						<span className="select-all">{order.externalOrderId}</span>
						{order.orderUrl && (
							<a
								href={order.orderUrl}
								target="_blank"
								rel="noreferrer"
								aria-label="Open order on store site"
								className="inline-flex items-center hover:text-foreground"
							>
								<IconExternalLink className="size-3" />
							</a>
						)}
						<span>{formatDate(order.orderDate, "long")}</span>
					</div>
				</div>
				<div className="text-right">
					<Money
						minor={order.totalMinor}
						currency={order.currency}
						className="text-lg font-semibold"
					/>
					<div className="mt-0.5">
						<Link
							to="/app/orders/$orderId"
							params={{ orderId: order.id }}
							className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
						>
							Full detail <Kbd>o</Kbd>
						</Link>
					</div>
				</div>
			</header>

			{/* Quick actions */}
			<section className="flex flex-col gap-2 rounded border border-border bg-card p-2">
				<SectionLabel>Assign entity</SectionLabel>
				<div className="flex flex-wrap gap-1">
					{activeEntities.slice(0, 9).map((entity, index) => {
						const active = order.entityId === entity.id;
						return (
							<button
								key={entity.id}
								type="button"
								aria-pressed={active}
								onClick={() => onAssign(active ? null : entity.id)}
								className={cn(
									"inline-flex h-6 items-center gap-1.5 rounded-sm border px-1.5 text-xs",
									active
										? "border-primary bg-primary/10"
										: "border-border hover:bg-accent",
								)}
							>
								<Kbd>{index + 1}</Kbd>
								<EntityChip
									entity={entity}
									className="border-0 bg-transparent px-0"
								/>
							</button>
						);
					})}
					<button
						type="button"
						onClick={() => onAssign(null)}
						disabled={!order.entityId}
						className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-dashed border-border px-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
					>
						<Kbd>0</Kbd>Unassign
					</button>
				</div>
				<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<CategorySelect
						label="Category"
						value={order.categoryId}
						categories={activeCategories}
						entityId={order.entityId}
						onChange={(categoryId) =>
							update.mutate({ id: order.id, categoryId })
						}
					/>
					<PaymentMethodSelect
						label="Payment method"
						value={order.paymentMethodId}
						methods={data?.paymentMethods ?? []}
						onChange={(paymentMethodId) =>
							update.mutate({ id: order.id, paymentMethodId })
						}
					/>
				</div>
				<PaymentSummary
					paymentMethodId={order.paymentMethodId}
					paymentHint={order.paymentHint}
				/>
				<div className="flex flex-wrap items-center gap-2">
					<span className="label-caps">Reimbursable</span>
					<fieldset
						aria-label="Reimbursable override"
						className="inline-flex overflow-hidden rounded-sm border border-border"
					>
						{REIMB_OPTIONS.map(([value, label]) => (
							<button
								key={label}
								type="button"
								aria-pressed={order.reimbursableOverride === value}
								onClick={() => onReimbursable(value)}
								className={cn(
									"h-5 px-2 text-[11px]",
									order.reimbursableOverride === value
										? "bg-primary/15 font-semibold text-primary"
										: "text-muted-foreground hover:bg-accent",
								)}
							>
								{label}
							</button>
						))}
					</fieldset>
					<Kbd>r</Kbd>
					<div className="ml-auto flex gap-1">
						<Button size="sm" variant="ghost" onClick={onIgnore}>
							<IconArchive />
							Ignore <Kbd>i</Kbd>
						</Button>
						<Button size="sm" variant="primary" onClick={onFile}>
							<IconCheck />
							File{" "}
							<Kbd className="border-primary-foreground/30 bg-transparent text-primary-foreground">
								e
							</Kbd>
						</Button>
					</div>
				</div>
			</section>

			<RulesHint detail={detail.data} />

			<Panel
				title={`Items · ${detail.data.items.length}`}
				bodyClassName="p-0"
				action={
					<Link
						to="/app/orders/$orderId"
						params={{ orderId: order.id }}
						className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
					>
						Split by item <IconArrowUpRight className="size-3" />
					</Link>
				}
			>
				<ItemsTable detail={detail.data} />
			</Panel>

			<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
				<Panel title="Totals">
					<TotalsBreakdown detail={detail.data} />
				</Panel>
				<Panel title="Allocation">
					<AllocationSection detail={detail.data} />
				</Panel>
			</div>

			<DuplicateHint orderId={orderId} />
			<DocumentsPanel
				orderId={order.id}
				documents={detail.data.documents}
				compact
			/>

			{detail.data.shipments.length > 0 && (
				<Panel title="Shipments">
					<ShipmentsList detail={detail.data} />
				</Panel>
			)}

			{order.notes && (
				<Panel title="Notes">
					<p className="whitespace-pre-wrap text-xs">{order.notes}</p>
				</Panel>
			)}
		</div>
	);
}
