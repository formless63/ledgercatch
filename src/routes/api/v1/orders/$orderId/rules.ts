import { createFileRoute } from "@tanstack/react-router";
import { explainOrderRulesApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/$orderId/rules")({
	server: {
		handlers: {
			GET: ({ request, params }) => explainOrderRulesApi(request, params),
		},
	},
});
