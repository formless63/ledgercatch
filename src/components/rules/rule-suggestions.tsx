import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Panel } from "#/components/app/primitives";
import { errorText } from "#/components/settings/ui";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import {
	acceptRuleSuggestion,
	listRuleSuggestions,
} from "#/features/ledger/rule-suggestions.functions";

export function RuleSuggestions() {
	const { activeEntities } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const query = useQuery({
		queryKey: ["ledger", "rule-suggestions"],
		queryFn: () => listRuleSuggestions(),
	});
	const [choices, setChoices] = useState<Record<string, string>>({});
	const accept = useMutation({
		mutationFn: (data: Parameters<typeof acceptRuleSuggestion>[0]["data"]) =>
			acceptRuleSuggestion({ data }),
		onSuccess: async (result) => {
			toast.success(`Rule saved · ${result.changed} inbox orders updated`);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	if (query.isError)
		return <p className="text-xs text-destructive">{errorText(query.error)}</p>;
	if (!query.data?.length) return null;
	const labels = {
		payment_last4: "Card last-4",
		placed_by_group: "Placed by group",
		ship_to_address: "Ship-to address",
		checkout_email_domain: "Checkout email domain",
	};
	return (
		<Panel title="Suggested entity rules" bodyClassName="p-0">
			<p className="px-3 py-2 text-xs text-muted-foreground">
				Choose an entity to save a rule and apply rules to your inbox.
			</p>
			<ul className="divide-y divide-border">
				{query.data.map((candidate) => {
					const entityId =
						choices[candidate.key] ?? candidate.suggestedEntityId ?? "";
					return (
						<li
							key={candidate.key}
							className="flex flex-wrap items-center gap-2 px-3 py-2"
						>
							<div className="min-w-0 flex-1">
								<span className="block text-[11px] text-muted-foreground">
									{labels[candidate.field]} · {candidate.matchCount} unassigned
									orders
								</span>
								<span className="break-words text-xs">{candidate.value}</span>
							</div>
							<select
								aria-label={`Entity for ${candidate.value}`}
								value={entityId}
								onChange={(event) =>
									setChoices((prev) => ({
										...prev,
										[candidate.key]: event.target.value,
									}))
								}
								className="max-w-44 rounded border border-border bg-background px-2 py-1 text-xs"
							>
								<option value="">Choose entity…</option>
								{activeEntities.map((entity) => (
									<option key={entity.id} value={entity.id}>
										{entity.name}
									</option>
								))}
							</select>
							<Button
								disabled={!entityId || accept.isPending}
								onClick={() =>
									accept.mutate({
										field: candidate.field,
										value: candidate.value,
										entityId,
									})
								}
							>
								Accept &amp; apply
							</Button>
						</li>
					);
				})}
			</ul>
		</Panel>
	);
}
