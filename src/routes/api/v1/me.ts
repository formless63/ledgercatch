import { createFileRoute } from "@tanstack/react-router";
import { getMeApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/me")({
	server: {
		handlers: {
			GET: ({ request }) => getMeApi(request),
		},
	},
});
