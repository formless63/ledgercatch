import { createFileRoute } from "@tanstack/react-router";
import { getCaptureApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/captures/$captureId")({
	server: {
		handlers: {
			GET: ({ request, params }) => getCaptureApi(request, params),
		},
	},
});
