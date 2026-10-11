import { createFileRoute } from "@tanstack/react-router";
import { reprocessCaptureApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/captures/$captureId/reprocess")({
	server: {
		handlers: {
			POST: ({ request, params }) => reprocessCaptureApi(request, params),
		},
	},
});
