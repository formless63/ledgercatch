import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
	InsightsPage,
	RANGE_PRESETS,
} from "#/components/insights/insights-page";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Route = createFileRoute("/app/insights")({
	validateSearch: z.object({
		range: z.enum(RANGE_PRESETS).optional().catch(undefined),
		from: date.optional().catch(undefined),
		to: date.optional().catch(undefined),
		entity: z.string().uuid().optional().catch(undefined),
		cur: z.string().length(3).optional().catch(undefined),
	}),
	component: InsightsRoute,
});

function InsightsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<InsightsPage
			search={search}
			onSearch={(next) =>
				void navigate({
					search: (prev) => ({ ...prev, ...next }),
					replace: true,
				})
			}
		/>
	);
}
