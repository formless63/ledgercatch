import { createFileRoute } from "@tanstack/react-router";
import { enrichmentResultApi } from "#/features/ingress/enrichment/api.server";

export const Route = createFileRoute("/api/v1/enrichment/$id/result")({
	server: {
		handlers: {
			POST: ({ request, params }) => enrichmentResultApi(request, params.id),
		},
	},
});
