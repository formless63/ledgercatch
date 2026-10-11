/**
 * "Possible duplicate of …" hint (#6) for order detail and the inbox
 * inspector, with Merge and "Not a duplicate" actions.
 */
import { IconCopy, IconGitMerge, IconX } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate } from "#/components/app/format";
import { Button, Money, StoreMark, Tag } from "#/components/app/primitives";
import { errorMessage } from "#/components/orders/shared";
import { useInvalidateLedger } from "#/features/ledger/hooks";
import type { DuplicateCandidateRow } from "#/features/lifecycle/duplicates.server";
import { lifecycleKeys } from "#/features/lifecycle/hooks";
import {
	dismissDuplicate,
	getDuplicateCandidates,
	getDuplicateFlags,
	mergeOrders,
} from "#/features/lifecycle/lifecycle.functions";
import { cn } from "#/lib/utils";

export function useDuplicateCandidates(orderId: string) {
	return useQuery({
		queryKey: lifecycleKeys.duplicates(orderId),
		queryFn: () => getDuplicateCandidates({ data: { orderId } }),
		staleTime: 60_000,
	});
}

/** Set of order ids (among `orderIds`) with an open duplicate candidate. */
export function useDuplicateFlags(orderIds: string[]) {
	return useQuery({
		queryKey: lifecycleKeys.duplicateFlags(orderIds),
		queryFn: async () =>
			new Set(await getDuplicateFlags({ data: { orderIds } })),
		enabled: orderIds.length > 0,
		staleTime: 60_000,
	});
}

/** Tiny chip for list rows (pair with useDuplicateFlags). */
export function DuplicateChip({ className }: { className?: string }) {
	return (
		<Tag tone="warning" className={className} title="Possible duplicate order">
			<IconCopy className="size-3" />
			dup?
		</Tag>
	);
}

export function DuplicateHint({
	orderId,
	className,
	/** Called after a merge removed `orderId` (inbox: move selection). */
	onMergedAway,
}: {
	orderId: string;
	className?: string;
	onMergedAway?: (keptId: string) => void;
}) {
	const query = useDuplicateCandidates(orderId);
	const candidates = query.data ?? [];
	if (candidates.length === 0) return null;
	return (
		<div
			className={cn(
				"flex flex-col gap-1.5 rounded border border-amber-500/35 bg-amber-500/8 px-3 py-2",
				className,
			)}
		>
			<div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
				<IconCopy className="size-3.5" />
				Possible duplicate{candidates.length > 1 ? "s" : ""}
			</div>
			{candidates.map((candidate) => (
				<CandidateRow
					key={candidate.otherId}
					orderId={orderId}
					candidate={candidate}
					onMergedAway={onMergedAway}
				/>
			))}
		</div>
	);
}

function CandidateRow({
	orderId,
	candidate,
	onMergedAway,
}: {
	orderId: string;
	candidate: DuplicateCandidateRow;
	onMergedAway?: (keptId: string) => void;
}) {
	const invalidate = useInvalidateLedger();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState(false);
	const [keepId, setKeepId] = useState(candidate.suggestedKeepId);
	const other = candidate.other;
	const onError = (error: unknown) => toast.error(errorMessage(error));

	const dismiss = useMutation({
		mutationFn: () =>
			dismissDuplicate({ data: { orderId, otherId: candidate.otherId } }),
		onSuccess: () => {
			toast.success("Marked as not a duplicate");
			void invalidate();
		},
		onError,
	});
	const merge = useMutation({
		mutationFn: () => {
			const dropId = keepId === orderId ? candidate.otherId : orderId;
			return mergeOrders({ data: { keepId, dropId } });
		},
		onSuccess: (result) => {
			toast.success(
				`Merged${result.documentsMoved ? ` · ${result.documentsMoved} document(s) moved` : ""}`,
			);
			void invalidate();
			if (result.mergedOrderId === orderId) {
				if (onMergedAway) onMergedAway(result.keepId);
				else
					void navigate({
						to: "/app/orders/$orderId",
						params: { orderId: result.keepId },
						replace: true,
					});
			}
		},
		onError,
	});

	return (
		<div className="flex flex-col gap-1.5 text-xs">
			<div className="flex flex-wrap items-center gap-2">
				<StoreMark source={other.source} className="text-[11px]" />
				<Link
					to="/app/orders/$orderId"
					params={{ orderId: other.id }}
					className="font-mono text-[11px] hover:underline"
				>
					{other.externalOrderId}
				</Link>
				<span className="font-mono text-[11px] text-muted-foreground">
					{formatDate(other.orderDate)}
				</span>
				<Money minor={other.totalMinor} currency={other.currency} />
				<Tag tone="warning" title={candidate.reasons.join(" · ")}>
					{Math.round(candidate.score * 100)}%
				</Tag>
				<span className="min-w-0 truncate text-[11px] text-muted-foreground">
					{candidate.reasons.join(" · ")}
				</span>
			</div>
			{confirming ? (
				<div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-card px-2 py-1.5">
					<span className="text-[11px] text-muted-foreground">Keep:</span>
					<label className="flex items-center gap-1 text-[11px]">
						<input
							type="radio"
							checked={keepId === orderId}
							onChange={() => setKeepId(orderId)}
						/>
						this order
					</label>
					<label className="flex items-center gap-1 text-[11px]">
						<input
							type="radio"
							checked={keepId === candidate.otherId}
							onChange={() => setKeepId(candidate.otherId)}
						/>
						{other.externalOrderId}
					</label>
					<span className="text-[10px] text-muted-foreground">
						Captures, documents and shipments move to the kept order; the other
						is deleted (audited).
					</span>
					<span className="ml-auto flex gap-1">
						<Button size="xs" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<Button
							size="xs"
							variant="primary"
							disabled={merge.isPending}
							onClick={() => merge.mutate()}
						>
							{merge.isPending ? "Merging…" : "Confirm merge"}
						</Button>
					</span>
				</div>
			) : (
				<div className="flex gap-1">
					<Button size="xs" onClick={() => setConfirming(true)}>
						<IconGitMerge />
						Merge
					</Button>
					<Button
						size="xs"
						variant="ghost"
						disabled={dismiss.isPending}
						onClick={() => dismiss.mutate()}
					>
						<IconX />
						Not a duplicate
					</Button>
				</div>
			)}
		</div>
	);
}
