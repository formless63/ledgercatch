import { createFileRoute } from "@tanstack/react-router";
import { getClaimApi, updateClaimApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/claims/$claimId")({
	server: {
		handlers: {
			GET: ({ request, params }) => getClaimApi(request, params),
			PATCH: ({ request, params }) => updateClaimApi(request, params),
		},
	},
});
