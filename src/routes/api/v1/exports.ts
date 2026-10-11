import { createFileRoute } from "@tanstack/react-router";
import { queueExportApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/exports")({
	server: {
		handlers: {
			POST: ({ request }) => queueExportApi(request),
		},
	},
});
