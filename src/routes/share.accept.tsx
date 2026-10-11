import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AcceptInvite } from "#/components/sharing/portal";

export const Route = createFileRoute("/share/accept")({
	validateSearch: z.object({
		token: z.string().min(16).max(256).optional().catch(undefined),
	}),
	component: AcceptRoute,
});

function AcceptRoute() {
	const { token } = Route.useSearch();
	return <AcceptInvite token={token} />;
}
