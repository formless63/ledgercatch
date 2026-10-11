/** Full order detail: classification, items, allocation, documents, exports, provenance. */
import {
	IconArchive,
	IconArrowBackUp,
	IconArrowLeft,
	IconCheck,
	IconCopy,
	IconExternalLink,
	IconInbox,
	IconX,
} from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	formatDate,
	formatRelative,
	ORDER_STATUS_TONES,
} from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Field,
	Input,
	Kbd,
	Money,
	Panel,
	StoreMark,
	Tag,
	Textarea,
} from "#/components/app/primitives";
import { DuplicateHint } from "#/components/lifecycle/duplicate-hint";
import { RefundsSection } from "#/components/lifecycle/refunds-section";
import { TaxHints } from "#/components/money/tax-hints";
import { useBootstrap } from "#/features/ledger/hooks";
import type { OrderDetail } from "#/features/ledger/ledger.server";
import { cn } from "#/lib/utils";
import { DocumentsPanel } from "./documents";
import { useOrderDetail } from "./inspector";
import {
	AllocationSection,
	CapturesList,
	ExportsSection,
	HistoryTimeline,
	ItemsTable,
	RulesHint,
	ShipmentsList,
	TotalsBreakdown,
} from "./sections";
import {
	CategorySelect,
	EntitySelect,
	errorMessage,
	nextReimbursable,
	PaymentMethodSelect,
	PaymentSummary,
	ReviewTag,
	reimbursableLabel,
	useHotkeys,
	useOrderActions,
} from "./shared";

const REIMB_OPTIONS: Array<[boolean | null, string, string]> = [
	[null, "Auto", "Derived: paying entity ≠ owning entity"],
	[true, "Yes", "Always reimbursable"],
	[false, "No", "Never reimbursable"],
];

export function OrderDetailPage({ orderId }: { orderId: string }) {
	const detail = useOrderDetail(orderId);
	const router = useRouter();

	if (detail.isPending)
		return (
			<div className="flex flex-col gap-3 p-4" aria-busy="true">
				<div className="h-6 w-1/3 animate-pulse rounded-sm bg-muted" />
				<div className="h-4 w-1/4 animate-pulse rounded-sm bg-muted" />
				<div className="h-48 animate-pulse rounded-sm bg-muted" />
			</div>
		);
	if (detail.isError || !detail.data)
		return (
			<div className="p-4">
				<EmptyState
					title="Order not found"
					action={
						<Button onClick={() => router.history.back()}>
							<IconArrowLeft />
							Back
						</Button>
					}
				>
					{detail.error ? errorMessage(detail.error) : null}
				</EmptyState>
			</div>
		);
	return <OrderDetailView detail={detail.data} />;
}

function OrderDetailView({ detail }: { detail: OrderDetail }) {
	const router = useRouter();
	const { activeEntities, activeCategories, entityById, data } = useBootstrap();
	const { update } = useOrderActions();
	const { order } = detail;

	const setReview = (reviewState: "inbox" | "filed" | "ignored") => {
		if (order.reviewState === reviewState) return;
		update.mutate(
			{ id: order.id, reviewState },
			{
				onSuccess: () =>
					toast.success(
						reviewState === "filed"
							? "Filed"
							: reviewState === "ignored"
								? "Ignored"
								: "Moved back to inbox",
					),
			},
		);
	};
	const assign = (entityId: string | null) => {
		if (order.entityId !== entityId) update.mutate({ id: order.id, entityId });
	};

	useHotkeys((event) => {
		const key = event.key;
		if (/^[1-9]$/.test(key)) {
			const entity = activeEntities[Number(key) - 1];
			if (entity) assign(entity.id);
		} else if (key === "0") assign(null);
		else if (key === "r") {
			const next = nextReimbursable(order.reimbursableOverride);
			update.mutate({ id: order.id, reimbursableOverride: next });
			toast(`Reimbursable: ${reimbursableLabel(next)}`, { duration: 1200 });
		} else if (key === "e") setReview("filed");
		else if (key === "i") setReview("ignored");
		else if (key === "u") setReview("inbox");
		else if (key === "Backspace" || key === "Escape") router.history.back();
	});

	const entity = order.entityId ? entityById.get(order.entityId) : undefined;

	return (
		<div className="flex flex-col">
			{/* Header */}
			<header className="border-b border-border px-3 py-2.5 sm:px-4">
				<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<button
						type="button"
						onClick={() => router.history.back()}
						className="inline-flex items-center gap-1 rounded-sm hover:text-foreground"
					>
						<IconArrowLeft className="size-3.5" />
						Back
					</button>
					<span aria-hidden>/</span>
					<Link to="/app/orders" className="hover:text-foreground">
						Orders
					</Link>
					<span aria-hidden>/</span>
					<StoreMark source={order.source} />
				</div>
				<div className="mt-1.5 flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<h1 className="truncate text-lg font-semibold tracking-tight">
							{order.merchantName ?? "Unknown merchant"}
						</h1>
						<div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs">
							<span className="select-all font-mono text-muted-foreground">
								{order.externalOrderId}
							</span>
							<button
								type="button"
								aria-label="Copy order number"
								className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
								onClick={() => {
									void navigator.clipboard
										?.writeText(order.externalOrderId)
										.then(() => toast.success("Order number copied"));
								}}
							>
								<IconCopy className="size-3" />
							</button>
							{order.orderUrl && (
								<a
									href={order.orderUrl}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
								>
									View on store <IconExternalLink className="size-3" />
								</a>
							)}
							<Tag tone={ORDER_STATUS_TONES[order.status] ?? "neutral"}>
								{order.status}
							</Tag>
							{order.statusText &&
								order.statusText.toLowerCase() !== order.status && (
									<span className="text-[11px] text-muted-foreground">
										{order.statusText}
									</span>
								)}
							{order.placedByGroup && (
								<span className="text-[11px] text-muted-foreground">
									Placed by group: {order.placedByGroup}
								</span>
							)}
							<ReviewTag state={order.reviewState} />
							<span className="font-mono text-[11px] text-muted-foreground">
								{formatDate(order.orderDate, "long")}
							</span>
						</div>
					</div>
					<div className="flex flex-col items-end gap-1.5">
						<Money
							minor={order.totalMinor}
							currency={order.currency}
							className="text-xl font-semibold"
						/>
						<div className="flex flex-wrap justify-end gap-1">
							{order.reviewState === "inbox" ? (
								<>
									<Button variant="ghost" onClick={() => setReview("ignored")}>
										<IconArchive />
										Ignore <Kbd>i</Kbd>
									</Button>
									<Button variant="primary" onClick={() => setReview("filed")}>
										<IconCheck />
										File
									</Button>
								</>
							) : (
								<>
									<Button onClick={() => setReview("inbox")}>
										{order.reviewState === "filed" ? (
											<IconArrowBackUp />
										) : (
											<IconInbox />
										)}
										{order.reviewState === "filed"
											? "Unfile"
											: "Restore to inbox"}
										<Kbd>u</Kbd>
									</Button>
									{order.reviewState === "filed" ? (
										<Button
											variant="ghost"
											onClick={() => setReview("ignored")}
										>
											<IconArchive />
											Ignore
										</Button>
									) : (
										<Button
											variant="primary"
											onClick={() => setReview("filed")}
										>
											<IconCheck />
											File
										</Button>
									)}
								</>
							)}
						</div>
						{order.filedAt && order.reviewState === "filed" && (
							<span className="font-mono text-[10px] text-muted-foreground">
								filed {formatRelative(order.filedAt)}
							</span>
						)}
					</div>
				</div>
			</header>

			<div className="grid grid-cols-1 gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_340px]">
				{/* Main column */}
				<div className="flex min-w-0 flex-col gap-3">
					<DuplicateHint orderId={order.id} />
					<Panel
						title={`Line items · ${detail.items.length}`}
						bodyClassName="p-0"
					>
						<ItemsTable detail={detail} editable />
					</Panel>
					<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
						<Panel title="Allocation">
							<AllocationSection detail={detail} editable />
						</Panel>
						<Panel title="Totals">
							<TotalsBreakdown detail={detail} />
						</Panel>
					</div>
					<DocumentsPanel orderId={order.id} documents={detail.documents} />
					<RefundsSection detail={detail} />
					<Panel title="Exports">
						<ExportsSection detail={detail} />
					</Panel>
				</div>

				{/* Side column */}
				<div className="flex min-w-0 flex-col gap-3">
					<Panel title="Classification">
						<div className="flex flex-col gap-2.5">
							<Field
								label={
									<span className="flex items-center justify-between">
										Entity
										<span className="font-normal normal-case tracking-normal">
											<Kbd>1</Kbd>–<Kbd>9</Kbd>
										</span>
									</span>
								}
							>
								<EntitySelect
									label="Primary entity"
									value={order.entityId}
									entities={activeEntities}
									onChange={assign}
								/>
							</Field>
							{entity && detail.items.some((item) => item.entityId) && (
								<p className="-mt-1 text-[11px] text-muted-foreground">
									Some items override <EntityChip entity={entity} short />.
								</p>
							)}
							<Field label="Category">
								<CategorySelect
									label="Category"
									value={order.categoryId}
									categories={activeCategories}
									entityId={order.entityId}
									onChange={(categoryId) =>
										update.mutate({ id: order.id, categoryId })
									}
								/>
							</Field>
							<Field label="Payment method">
								<PaymentMethodSelect
									label="Payment method"
									value={order.paymentMethodId}
									methods={data?.paymentMethods ?? []}
									onChange={(paymentMethodId) =>
										update.mutate({ id: order.id, paymentMethodId })
									}
								/>
							</Field>
							<PaymentSummary
								paymentMethodId={order.paymentMethodId}
								paymentHint={order.paymentHint}
							/>
							{order.paymentHint && order.paymentMethodId && (
								<p className="-mt-1 font-mono text-[10px] text-muted-foreground">
									Captured: {order.paymentHint}
								</p>
							)}
							<div className="flex flex-col gap-1">
								<span className="label-caps flex items-center justify-between">
									Reimbursable <Kbd>r</Kbd>
								</span>
								<fieldset
									aria-label="Reimbursable override"
									className="grid grid-cols-3 overflow-hidden rounded-sm border border-border"
								>
									{REIMB_OPTIONS.map(([value, label, title]) => (
										<button
											key={label}
											type="button"
											title={title}
											aria-pressed={order.reimbursableOverride === value}
											onClick={() =>
												update.mutate({
													id: order.id,
													reimbursableOverride: value,
												})
											}
											className={cn(
												"h-6 text-xs",
												order.reimbursableOverride === value
													? "bg-primary/15 font-semibold text-primary"
													: "text-muted-foreground hover:bg-accent",
											)}
										>
											{label}
										</button>
									))}
								</fieldset>
							</div>
						</div>
					</Panel>
					<TaxHints orderId={order.id} />

					<RulesHint detail={detail} />

					<NotesAndTags detail={detail} />

					<Panel title={`Shipments · ${detail.shipments.length}`}>
						<ShipmentsList detail={detail} />
					</Panel>

					<Panel title={`Captures · ${detail.captures.length}`}>
						<CapturesList detail={detail} />
					</Panel>

					<Panel title="History" bodyClassName="max-h-96 overflow-y-auto p-3">
						<HistoryTimeline detail={detail} />
					</Panel>
				</div>
			</div>
		</div>
	);
}

function NotesAndTags({ detail }: { detail: OrderDetail }) {
	const { order } = detail;
	const { update } = useOrderActions();
	const [notes, setNotes] = useState(order.notes ?? "");
	const [tagDraft, setTagDraft] = useState("");
	useEffect(() => setNotes(order.notes ?? ""), [order.notes]);

	const saveNotes = () => {
		const value = notes.trim() ? notes : null;
		if (value === (order.notes ?? null)) return;
		update.mutate(
			{ id: order.id, notes: value },
			{ onSuccess: () => toast.success("Notes saved", { duration: 1200 }) },
		);
	};
	const setTags = (tags: string[]) => update.mutate({ id: order.id, tags });
	const addTag = () => {
		const tag = tagDraft.trim().replace(/,$/, "").slice(0, 40);
		setTagDraft("");
		if (!tag || order.tags.includes(tag)) return;
		if (order.tags.length >= 20) return toast.error("At most 20 tags");
		setTags([...order.tags, tag]);
	};

	return (
		<Panel title="Notes & tags">
			<div className="flex flex-col gap-2">
				<Textarea
					aria-label="Notes"
					placeholder="Add a note (saved when you leave the field)"
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
					onBlur={saveNotes}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							saveNotes();
						}
					}}
					rows={3}
				/>
				<div className="flex flex-wrap items-center gap-1">
					{order.tags.map((tag) => (
						<span
							key={tag}
							className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-muted px-1.5 font-mono text-[10px]"
						>
							{tag}
							<button
								type="button"
								aria-label={`Remove tag ${tag}`}
								onClick={() => setTags(order.tags.filter((t) => t !== tag))}
								className="text-muted-foreground hover:text-foreground"
							>
								<IconX className="size-3" />
							</button>
						</span>
					))}
					<Input
						aria-label="Add tag"
						placeholder="+ tag"
						value={tagDraft}
						onChange={(event) => setTagDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === ",") {
								event.preventDefault();
								addTag();
							}
						}}
						onBlur={() => tagDraft.trim() && addTag()}
						className="h-5 w-24 text-[11px]"
					/>
				</div>
			</div>
		</Panel>
	);
}
