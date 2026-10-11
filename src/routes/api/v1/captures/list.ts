import { createFileRoute } from "@tanstack/react-router";
import { listCapturesApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/captures/list")({
	server: {
		handlers: {
			GET: ({ request }) => listCapturesApi(request),
		},
	},
});
