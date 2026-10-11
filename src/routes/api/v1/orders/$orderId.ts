import { createFileRoute } from "@tanstack/react-router";
import { getOrderApi, updateOrderApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/$orderId")({
	server: {
		handlers: {
			GET: ({ request, params }) => getOrderApi(request, params),
			PATCH: ({ request, params }) => updateOrderApi(request, params),
		},
	},
});
