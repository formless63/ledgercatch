import { createFileRoute } from "@tanstack/react-router";
import {
	deleteRuleApi,
	replaceRuleApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/rules/$ruleId")({
	server: {
		handlers: {
			PUT: ({ request, params }) => replaceRuleApi(request, params),
			DELETE: ({ request, params }) => deleteRuleApi(request, params),
		},
	},
});
