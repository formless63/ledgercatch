import { createFileRoute } from "@tanstack/react-router";
import {
	createClaimApi,
	listClaimsApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/claims/")({
	server: {
		handlers: {
			GET: ({ request }) => listClaimsApi(request),
			POST: ({ request }) => createClaimApi(request),
		},
	},
});
