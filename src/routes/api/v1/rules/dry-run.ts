import { createFileRoute } from "@tanstack/react-router";
import { dryRunRuleApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/rules/dry-run")({
	server: {
		handlers: {
			POST: ({ request }) => dryRunRuleApi(request),
		},
	},
});
