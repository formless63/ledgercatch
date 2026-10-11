import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ReimbursementsPage } from "#/components/reimbursements/reimbursements-page";

export const Route = createFileRoute("/app/reimbursements")({
	validateSearch: z.object({
		claim: z.string().uuid().optional().catch(undefined),
	}),
	component: ReimbursementsRoute,
});

function ReimbursementsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ReimbursementsPage
			claimId={search.claim ?? null}
			onClaimChange={(claim) =>
				void navigate({ search: { claim: claim ?? undefined }, replace: true })
			}
		/>
	);
}
