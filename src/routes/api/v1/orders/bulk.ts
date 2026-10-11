import { createFileRoute } from "@tanstack/react-router";
import { bulkUpdateOrdersApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/bulk")({
	server: {
		handlers: {
			POST: ({ request }) => bulkUpdateOrdersApi(request),
		},
	},
});
