import { createFileRoute } from "@tanstack/react-router";
import { ignoreCaptureApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/captures/$captureId/ignore")({
	server: {
		handlers: {
			POST: ({ request, params }) => ignoreCaptureApi(request, params),
		},
	},
});
