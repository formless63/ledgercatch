import { createFileRoute } from "@tanstack/react-router";
import { updateEntityApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/entities/$entityId")({
	server: {
		handlers: {
			PATCH: ({ request, params }) => updateEntityApi(request, params),
		},
	},
});
