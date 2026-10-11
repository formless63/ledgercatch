import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SharedEntityHeader } from "#/components/sharing/portal";

export const Route = createFileRoute("/share/$entityId")({
	component: SharedEntityLayout,
});

function SharedEntityLayout() {
	const { entityId } = Route.useParams();
	return (
		<>
			<SharedEntityHeader entityId={entityId} />
			<Outlet />
		</>
	);
}
