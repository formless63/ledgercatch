import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SharedExpenses } from "#/components/sharing/portal";

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.optional()
	.catch(undefined);

export const Route = createFileRoute("/share/$entityId/")({
	validateSearch: z.object({
		from: isoDate,
		to: isoDate,
		q: z.string().max(200).optional().catch(undefined),
		page: z.number().int().min(0).optional().catch(undefined),
	}),
	component: SharedExpensesRoute,
});

function SharedExpensesRoute() {
	const { entityId } = Route.useParams();
	const filters = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<SharedExpenses
			entityId={entityId}
			filters={filters}
			onFiltersChange={(next) =>
				void navigate({
					search: {
						from: next.from,
						to: next.to,
						q: next.q,
						page: next.page ? next.page : undefined,
					},
					replace: true,
				})
			}
		/>
	);
}
