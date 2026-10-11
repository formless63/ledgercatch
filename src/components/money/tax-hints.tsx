import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate } from "#/components/app/format";
import {
	Button,
	EntityChip,
	Money,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import { TAX_TREATMENTS, type TaxTreatment } from "#/features/money/constants";
import {
	acceptTaxTreatment,
	clearTaxTreatment,
	getTaxSuggestions,
} from "#/features/money/money.functions";
import { TAX_TREATMENT_LABELS } from "#/features/money/tax";
import { moneyKeys } from "./keys";

/**
 * "Tax view" for the order detail page: advisory treatment hints per
 * allocation. Nothing is stored until the user accepts a suggestion or
 * picks a treatment.
 */
export function TaxHints({
	orderId,
	className,
}: {
	orderId: string;
	className?: string;
}) {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: moneyKeys.tax(orderId),
		queryFn: () => getTaxSuggestions({ data: { id: orderId } }),
	});
	const refresh = () =>
		void client.invalidateQueries({ queryKey: moneyKeys.tax(orderId) });
	const accept = useMutation({
		mutationFn: (data: {
			allocationId: string;
			treatment: TaxTreatment;
			origin: "suggestion" | "manual";
		}) => acceptTaxTreatment({ data }),
		onSuccess: () => {
			toast.success("Tax treatment noted");
			refresh();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const clear = useMutation({
		mutationFn: (allocationId: string) =>
			clearTaxTreatment({ data: { allocationId } }),
		onSuccess: refresh,
		onError: (error) => toast.error(errorMessage(error)),
	});

	const data = query.data;
	return (
		<Panel title="Tax view" className={className}>
			{query.isError && (
				<div className="text-xs text-red-500">{errorMessage(query.error)}</div>
			)}
			{data && !data.allocations.length && (
				<div className="text-xs text-muted-foreground">
					Assign the order to an entity to see tax hints.
				</div>
			)}
			<div className="flex flex-col gap-3">
				{data?.allocations.map((allocation) => (
					<div key={allocation.allocationId} className="flex flex-col gap-1.5">
						<div className="flex items-center gap-2 text-xs">
							<EntityChip entity={allocation.entity} short />
							<Money
								minor={allocation.amountMinor}
								currency={allocation.currency}
							/>
							{allocation.category && (
								<span className="text-muted-foreground">
									· {allocation.category}
								</span>
							)}
						</div>
						{allocation.accepted ? (
							<div className="flex flex-wrap items-center gap-2 rounded-sm border border-emerald-500/30 bg-emerald-500/8 px-2 py-1 text-xs">
								<IconCheck className="size-3.5 text-emerald-500" />
								<span className="font-medium">{allocation.accepted.label}</span>
								{allocation.accepted.hint && (
									<span className="text-muted-foreground">
										— {allocation.accepted.hint}
									</span>
								)}
								<span className="text-[11px] text-muted-foreground">
									accepted {formatDate(allocation.accepted.acceptedAt)}
								</span>
								{allocation.accepted.amountChanged && (
									<Tag tone="warning">amount changed since</Tag>
								)}
								<Button
									size="xs"
									variant="ghost"
									className="ml-auto"
									onClick={() => clear.mutate(allocation.allocationId)}
								>
									<IconX />
									Clear
								</Button>
							</div>
						) : (
							<>
								{allocation.suggestions.map((suggestion) => (
									<div
										key={suggestion.treatment}
										className="flex items-start gap-2 rounded-sm border border-border px-2 py-1 text-xs"
									>
										<div className="min-w-0 flex-1">
											<div>
												<span className="font-medium">{suggestion.label}</span>
												{suggestion.hint && (
													<span className="text-muted-foreground">
														{" "}
														— {suggestion.hint}
													</span>
												)}
											</div>
											<div className="text-[11px] text-muted-foreground">
												{suggestion.reasons.join("; ")}
											</div>
										</div>
										<Tag
											tone="neutral"
											title="Heuristic confidence, not a determination"
										>
											{Math.round(suggestion.confidence * 100)}%
										</Tag>
										<Button
											size="xs"
											disabled={accept.isPending}
											onClick={() =>
												accept.mutate({
													allocationId: allocation.allocationId,
													treatment: suggestion.treatment,
													origin: "suggestion",
												})
											}
										>
											Accept
										</Button>
									</div>
								))}
								<ManualPick
									onPick={(treatment) =>
										accept.mutate({
											allocationId: allocation.allocationId,
											treatment,
											origin: "manual",
										})
									}
								/>
							</>
						)}
						{allocation.largeItems.length > 0 && (
							<div className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
								<IconAlertTriangle className="size-3.5" />
								{allocation.largeItems.length} item(s) ≥ $2,500 — review
								capitalization vs. expense with your accountant.
							</div>
						)}
					</div>
				))}
				{data && (
					<p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
						{data.disclaimer}
					</p>
				)}
			</div>
		</Panel>
	);
}

function ManualPick({ onPick }: { onPick: (treatment: TaxTreatment) => void }) {
	const [value, setValue] = useState("");
	return (
		<div className="flex items-center gap-2">
			<Select
				className="w-64"
				value={value}
				onChange={(event) => setValue(event.target.value)}
			>
				<option value="">Choose another treatment…</option>
				{TAX_TREATMENTS.map((treatment) => (
					<option key={treatment} value={treatment}>
						{TAX_TREATMENT_LABELS[treatment]}
					</option>
				))}
			</Select>
			<Button
				size="xs"
				disabled={!value}
				onClick={() => {
					onPick(value as TaxTreatment);
					setValue("");
				}}
			>
				Set
			</Button>
		</div>
	);
}
