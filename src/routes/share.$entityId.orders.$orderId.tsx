import { createFileRoute } from "@tanstack/react-router";
import { SharedOrderDetailView } from "#/components/sharing/portal";

export const Route = createFileRoute("/share/$entityId/orders/$orderId")({
	component: SharedOrderRoute,
});

function SharedOrderRoute() {
	const { entityId, orderId } = Route.useParams();
	return <SharedOrderDetailView entityId={entityId} orderId={orderId} />;
}
