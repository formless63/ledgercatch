/** Orders retained as history but no longer emitted by any linked capture. */
import {
	IconAlertTriangle,
	IconGitMerge,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Money, StoreMark, Tag } from "#/components/app/primitives";
import { errorMessage } from "#/components/orders/shared";
import { useInvalidateLedger } from "#/features/ledger/hooks";
import { listOrders } from "#/features/ledger/ledger.functions";
import {
	deleteUnsupportedOrder,
	listUnsupportedOrders,
} from "#/features/ledger/reparse-support.functions";
import { mergeOrders } from "#/features/lifecycle/lifecycle.functions";

type UnsupportedOrder = Awaited<
	ReturnType<typeof listUnsupportedOrders>
>[number];

export function UnsupportedOrders() {
	const query = useQuery({
		queryKey: ["ledger", "unsupported-orders"],
		queryFn: () => listUnsupportedOrders(),
		refetchInterval: 60_000,
		staleTime: 30_000,
	});
	if (query.isError)
		return (
			<p className="text-xs text-muted-foreground">
				Parser support checks are unavailable right now.
			</p>
		);
	if (!query.data?.length) return null;
	return (
		<div className="space-y-2 rounded border border-amber-500/35 bg-amber-500/8 px-3 py-2">
			<div className="flex items-center gap-1.5 text-xs font-semibold">
				<IconAlertTriangle className="size-3.5 text-amber-600" />
				<Tag tone="warning">{query.data[0]?.total}</Tag>
				Orders no current capture supports
			</div>
			<p className="text-xs text-muted-foreground">
				All linked captures have been re-parsed and no longer emit these orders.
				Review the captures before removing an order, or merge it into the real
				order to preserve its records.
			</p>
			{query.data.map((order) => (
				<UnsupportedOrderRow key={order.id} order={order} />
			))}
			{(query.data[0]?.total ?? 0) > query.data.length && (
				<p className="text-xs text-muted-foreground">
					Showing the first {query.data.length}; resolving these reveals the
					next orders.
				</p>
			)}
		</div>
	);
}

function UnsupportedOrderRow({ order }: { order: UnsupportedOrder }) {
	const invalidate = useInvalidateLedger();
	const [action, setAction] = useState<"delete" | "merge" | null>(null);
	const [search, setSearch] = useState("");
	const [keepId, setKeepId] = useState("");
	const candidates = useQuery({
		queryKey: ["ledger", "merge-targets", order.id, search],
		queryFn: () =>
			listOrders({
				data: { view: "all", q: search.trim() || undefined, limit: 25 },
			}),
		enabled: action === "merge",
	});
	const remove = useMutation({
		mutationFn: () => deleteUnsupportedOrder({ data: { id: order.id } }),
		onSuccess: () => {
			toast.success("Order deleted; captures retained");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const merge = useMutation({
		mutationFn: () => mergeOrders({ data: { keepId, dropId: order.id } }),
		onSuccess: () => {
			toast.success("Merged into the real order");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const busy = remove.isPending || merge.isPending;
	return (
		<div className="space-y-1.5 border-t border-amber-500/20 pt-2 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<StoreMark source={order.source} />
				<Link
					to="/app/orders/$orderId"
					params={{ orderId: order.id }}
					className="font-mono hover:underline"
				>
					{order.externalOrderId}
				</Link>
				<Money minor={order.totalMinor} currency={order.currency} />
				<span className="truncate text-muted-foreground">
					{order.merchantName}
				</span>
				<Button size="xs" disabled={busy} onClick={() => setAction("merge")}>
					<IconGitMerge />
					Merge
				</Button>
				<Button size="xs" disabled={busy} onClick={() => setAction("delete")}>
					<IconTrash />
					Delete
				</Button>
			</div>
			{action === "delete" && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-muted-foreground">
						Delete this order and its line items? Captures remain. Claimed or
						exported orders must be resolved first.
					</span>
					<Button size="xs" disabled={busy} onClick={() => setAction(null)}>
						Cancel
					</Button>
					<Button
						size="xs"
						variant="danger"
						disabled={busy}
						onClick={() => remove.mutate()}
					>
						{remove.isPending ? "Deleting…" : "Confirm delete"}
					</Button>
				</div>
			)}
			{action === "merge" && (
				<div className="flex flex-wrap items-center gap-2">
					<input
						type="search"
						aria-label={`Find real order for ${order.externalOrderId}`}
						placeholder="Find real order"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setKeepId("");
						}}
						className="h-7 rounded border border-input bg-background px-2 text-xs"
					/>
					<select
						aria-label={`Keep order when merging ${order.externalOrderId}`}
						value={keepId}
						onChange={(event) => setKeepId(event.target.value)}
						className="h-7 max-w-64 rounded border border-input bg-background px-2 text-xs"
					>
						<option value="">Choose order to keep</option>
						{candidates.data?.orders
							.filter((candidate) => candidate.id !== order.id)
							.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.source} {candidate.externalOrderId}{" "}
									{candidate.merchantName}
								</option>
							))}
					</select>
					{candidates.isError && (
						<span className="text-red-600">Could not load orders</span>
					)}
					<Button size="xs" disabled={busy} onClick={() => setAction(null)}>
						Cancel
					</Button>
					<Button
						size="xs"
						variant="primary"
						disabled={busy || !keepId}
						onClick={() => merge.mutate()}
					>
						{merge.isPending ? "Merging…" : "Confirm merge"}
					</Button>
				</div>
			)}
		</div>
	);
}
