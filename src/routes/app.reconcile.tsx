import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ReconcilePage } from "#/components/money/reconcile-page";

export const Route = createFileRoute("/app/reconcile")({
	validateSearch: z.object({
		tab: z
			.enum(["review", "imports", "tax", "settings"])
			.optional()
			.catch(undefined),
		card: z.string().uuid().optional().catch(undefined),
	}),
	component: ReconcileRoute,
});

function ReconcileRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ReconcilePage
			tab={search.tab ?? "review"}
			card={search.card ?? null}
			onSearch={(next) =>
				void navigate({
					search: (prev) => ({
						...prev,
						...(next.tab !== undefined ? { tab: next.tab } : {}),
						...(next.card !== undefined
							? { card: next.card ?? undefined }
							: {}),
					}),
					replace: true,
				})
			}
		/>
	);
}
