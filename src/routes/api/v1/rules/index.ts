import { createFileRoute } from "@tanstack/react-router";
import { createRuleApi, listRulesApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/rules/")({
	server: {
		handlers: {
			GET: ({ request }) => listRulesApi(request),
			POST: ({ request }) => createRuleApi(request),
		},
	},
});
