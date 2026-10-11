/**
 * Refunds panel for order detail (#10): list, status changes and the
 * "Record refund" dialog, plus net-of-refund allocation per entity.
 */
import { IconReceiptRefund, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate } from "#/components/app/format";
import {
	Button,
	EntityChip,
	Field,
	Input,
	Money,
	Panel,
	Select,
	Tag,
	Textarea,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/orders/shared";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import type { OrderDetail } from "#/features/ledger/ledger.server";
import { lifecycleKeys } from "#/features/lifecycle/hooks";
import {
	createRefund,
	deleteRefund,
	getOrderRefunds,
	updateRefund,
} from "#/features/lifecycle/lifecycle.functions";
import {
	REFUND_STATUSES,
	type RefundStatus,
} from "#/features/lifecycle/schema";
import { FormDialog, minorToInput, parseMoneyInput, todayIso } from "./shared";

export function useOrderRefunds(orderId: string) {
	return useQuery({
		queryKey: lifecycleKeys.refunds(orderId),
		queryFn: () => getOrderRefunds({ data: { orderId } }),
	});
}

export function RefundsSection({ detail }: { detail: OrderDetail }) {
	const { order, items } = detail;
	const { entityById } = useBootstrap();
	const query = useOrderRefunds(order.id);
	const invalidate = useInvalidateLedger();
	const [open, setOpen] = useState(false);
	const onError = (error: unknown) => toast.error(errorMessage(error));
	const update = useMutation({
		mutationFn: (input: { id: string; status: RefundStatus }) =>
			updateRefund({ data: input }),
		onSuccess: () => void invalidate(),
		onError,
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteRefund({ data: { id } }),
		onSuccess: () => {
			toast.success("Refund removed");
			void invalidate();
		},
		onError,
	});

	const data = query.data;
	const list = data?.refunds ?? [];
	const itemTitle = new Map(items.map((i) => [i.id, i.title]));
	const hasNetting = (data?.refundedMinor ?? 0) > 0;
	const suggestFull =
		(order.status === "cancelled" || order.status === "returned") &&
		list.length === 0;

	return (
		<Panel
			title={`Refunds · ${list.length}`}
			bodyClassName="p-0"
			action={
				<Button size="xs" onClick={() => setOpen(true)}>
					<IconReceiptRefund />
					Record refund
				</Button>
			}
		>
			{suggestFull && (
				<div className="flex items-center justify-between gap-2 border-b border-border bg-amber-500/8 px-3 py-1.5 text-[11px]">
					<span className="text-amber-700 dark:text-amber-400">
						Order is {order.status} but no refund is recorded; it still counts
						as spend.
					</span>
					<Button size="xs" onClick={() => setOpen(true)}>
						Record
					</Button>
				</div>
			)}
			{query.isPending ? (
				<div className="m-3 h-10 animate-pulse rounded-sm bg-muted" />
			) : query.isError ? (
				<p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">
					{errorMessage(query.error)}
				</p>
			) : list.length === 0 ? (
				<p className="px-3 py-2.5 text-xs text-muted-foreground">
					No refunds, returns or cancellations recorded.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[480px] border-collapse text-xs">
						<thead>
							<tr className="h-7 border-b border-border text-left">
								<th className="label-caps w-20 px-2">Date</th>
								<th className="label-caps px-2">For</th>
								<th className="label-caps w-28 px-2">Status</th>
								<th className="label-caps w-24 px-2 text-right">Amount</th>
								<th className="w-8 px-2">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{list.map((refund) => (
								<tr
									key={refund.id}
									className="h-7 border-b border-border/60 last:border-0 hover:bg-accent/40"
								>
									<td className="px-2 font-mono text-[11px] text-muted-foreground">
										{formatDate(refund.refundedAt ?? refund.createdAt)}
									</td>
									<td className="max-w-0 px-2">
										<div className="truncate">
											{refund.orderItemId
												? (itemTitle.get(refund.orderItemId) ?? "Item")
												: "Whole order"}
											{refund.reason && (
												<span className="text-muted-foreground">
													{" "}
													· {refund.reason}
												</span>
											)}
										</div>
										{refund.origin !== "manual" && (
											<span className="font-mono text-[9px] uppercase text-muted-foreground">
												via {refund.origin}
											</span>
										)}
									</td>
									<td className="px-2">
										<Select
											aria-label="Refund status"
											value={refund.status}
											className="h-5 text-[11px]"
											onChange={(e) =>
												update.mutate({
													id: refund.id,
													status: e.target.value as RefundStatus,
												})
											}
										>
											{REFUND_STATUSES.map((s) => (
												<option key={s} value={s}>
													{s}
												</option>
											))}
										</Select>
									</td>
									<td className="px-2 text-right">
										<Money
											minor={-refund.amountMinor}
											currency={refund.currency}
											className={
												refund.status === "refunded"
													? "text-emerald-600 dark:text-emerald-400"
													: "text-muted-foreground"
											}
										/>
									</td>
									<td className="px-2">
										<Button
											size="xs"
											variant="ghost"
											aria-label="Delete refund"
											onClick={() => {
												if (window.confirm("Delete this refund record?"))
													remove.mutate(refund.id);
											}}
										>
											<IconTrash />
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{data && (hasNetting || data.pendingRefundMinor > 0) && (
				<div className="flex flex-col gap-1 border-t border-border px-3 py-2">
					{data.allocations.map((a) => (
						<div key={a.id} className="flex items-center gap-2 text-xs">
							<EntityChip entity={entityById.get(a.entityId)} short />
							<span className="ml-auto flex items-center gap-1.5">
								<Money minor={a.amountMinor} currency={a.currency} muted />
								<span className="text-muted-foreground">→</span>
								<Money
									minor={a.netMinor}
									currency={a.currency}
									className="font-semibold"
								/>
							</span>
							{a.pendingRefundMinor > 0 && (
								<Tag
									tone="warning"
									title="Requested/approved, not yet refunded"
								>
									<Money
										minor={a.pendingRefundMinor}
										currency={a.currency}
										className="text-[10px]"
									/>{" "}
									pending
								</Tag>
							)}
						</div>
					))}
					<p className="text-[10px] text-muted-foreground">
						Net spend excludes refunded amounts; claims use the net figure.
					</p>
				</div>
			)}
			{open && (
				<RecordRefundDialog
					open={open}
					onOpenChange={setOpen}
					detail={detail}
					defaultFull={suggestFull}
				/>
			)}
		</Panel>
	);
}

export function RecordRefundDialog({
	open,
	onOpenChange,
	detail,
	defaultFull,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	detail: OrderDetail;
	defaultFull?: boolean;
}) {
	const { order, items, documents } = detail;
	const invalidate = useInvalidateLedger();
	const currencyDefault = order.currency ?? "USD";
	const blank = () => ({
		amount:
			defaultFull && order.totalMinor != null
				? minorToInput(order.totalMinor, currencyDefault)
				: "",
		currency: currencyDefault,
		orderItemId: "",
		status: (order.status === "cancelled"
			? "requested"
			: "refunded") as RefundStatus,
		refundedAt: todayIso(),
		reason:
			order.status === "cancelled"
				? "Cancelled"
				: order.status === "returned"
					? "Returned"
					: "",
		documentId: "",
	});
	const [form, setForm] = useState(blank);
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof ReturnType<typeof blank>>(
		key: K,
		value: ReturnType<typeof blank>[K],
	) => setForm((f) => ({ ...f, [key]: value }));

	const create = useMutation({
		mutationFn: (amountMinor: number) =>
			createRefund({
				data: {
					orderId: order.id,
					orderItemId: form.orderItemId || null,
					amountMinor,
					currency: form.currency,
					reason: form.reason || null,
					status: form.status,
					refundedAt:
						form.status === "refunded" ? form.refundedAt || null : null,
					documentId: form.documentId || null,
				},
			}),
		onSuccess: () => {
			toast.success("Refund recorded");
			void invalidate();
			onOpenChange(false);
		},
		onError: (e) => setError(errorMessage(e)),
	});

	const pickItem = (id: string) => {
		const item = items.find((i) => i.id === id);
		setForm((f) => ({
			...f,
			orderItemId: id,
			amount:
				item?.totalMinor != null && !f.amount
					? minorToInput(item.totalMinor, f.currency)
					: f.amount,
		}));
	};

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => {
				setError(null);
				onOpenChange(next);
			}}
			title="Record refund"
			description="Record a refund, return or cancellation for this order."
			submitLabel="Record refund"
			pending={create.isPending}
			error={error}
			onSubmit={() => {
				const minor = parseMoneyInput(form.amount, form.currency);
				if (minor == null || minor <= 0)
					return setError("Enter a positive amount");
				create.mutate(minor);
			}}
		>
			<Field label="Amount">
				<Input
					autoFocus
					required
					inputMode="decimal"
					value={form.amount}
					onChange={(e) => set("amount", e.target.value)}
					placeholder="0.00"
				/>
			</Field>
			<Field label="Currency">
				<Input
					value={form.currency}
					maxLength={3}
					onChange={(e) => set("currency", e.target.value.toUpperCase())}
				/>
			</Field>
			<Field label="Applies to" className="col-span-2">
				<Select
					value={form.orderItemId}
					onChange={(e) => pickItem(e.target.value)}
				>
					<option value="">Whole order (split across allocations)</option>
					{items.map((item) => (
						<option key={item.id} value={item.id}>
							{item.title.slice(0, 90)}
						</option>
					))}
				</Select>
			</Field>
			<Field label="Status">
				<Select
					value={form.status}
					onChange={(e) => set("status", e.target.value as RefundStatus)}
				>
					{REFUND_STATUSES.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</Select>
			</Field>
			<Field label="Refunded on">
				<Input
					type="date"
					value={form.refundedAt}
					disabled={form.status !== "refunded"}
					onChange={(e) => set("refundedAt", e.target.value)}
				/>
			</Field>
			<Field label="Reason" className="col-span-2">
				<Textarea
					rows={2}
					value={form.reason}
					onChange={(e) => set("reason", e.target.value)}
					placeholder="Returned, cancelled, partial refund, dispute…"
				/>
			</Field>
			{documents.length > 0 && (
				<Field label="Credit note / proof" className="col-span-2">
					<Select
						value={form.documentId}
						onChange={(e) => set("documentId", e.target.value)}
					>
						<option value="">None</option>
						{documents.map((d) => (
							<option key={d.id} value={d.id}>
								{d.kind} · {d.fileName}
							</option>
						))}
					</Select>
				</Field>
			)}
		</FormDialog>
	);
}
