import { createFileRoute } from "@tanstack/react-router";
import { nextEnrichmentApi } from "#/features/ingress/enrichment/api.server";

export const Route = createFileRoute("/api/v1/enrichment/next")({
	server: { handlers: { GET: ({ request }) => nextEnrichmentApi(request) } },
});
