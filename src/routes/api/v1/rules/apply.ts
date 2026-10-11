import { createFileRoute } from "@tanstack/react-router";
import { applyRulesApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/rules/apply")({
	server: {
		handlers: {
			POST: ({ request }) => applyRulesApi(request),
		},
	},
});
