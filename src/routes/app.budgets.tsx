import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "#/components/app/primitives";
import { BudgetsView } from "#/components/automation/budgets";

export const Route = createFileRoute("/app/budgets")({
	component: BudgetsPage,
});

function BudgetsPage() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title="Budgets"
				description="Per-entity spend limits for the current month, quarter or year. Alerts go through your notification settings."
			/>
			<BudgetsView />
		</div>
	);
}
