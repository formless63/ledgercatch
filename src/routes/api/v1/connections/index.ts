import { createFileRoute } from "@tanstack/react-router";
import { listConnectionsApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/connections/")({
	server: {
		handlers: {
			GET: ({ request }) => listConnectionsApi(request),
		},
	},
});
