import { createFileRoute } from "@tanstack/react-router";
import { testConnectionApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/connections/$connectionId/test")({
	server: {
		handlers: {
			POST: ({ request, params }) => testConnectionApi(request, params),
		},
	},
});
