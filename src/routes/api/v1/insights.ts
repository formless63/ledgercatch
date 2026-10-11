import { createFileRoute } from "@tanstack/react-router";
import { getInsightsApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/insights")({
	server: {
		handlers: {
			GET: ({ request }) => getInsightsApi(request),
		},
	},
});
