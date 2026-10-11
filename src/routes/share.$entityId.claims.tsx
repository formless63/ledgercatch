import { createFileRoute } from "@tanstack/react-router";
import { SharedClaims } from "#/components/sharing/portal";

export const Route = createFileRoute("/share/$entityId/claims")({
	component: SharedClaimsRoute,
});

function SharedClaimsRoute() {
	const { entityId } = Route.useParams();
	return <SharedClaims entityId={entityId} />;
}
