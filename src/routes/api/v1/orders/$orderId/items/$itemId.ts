import { createFileRoute } from "@tanstack/react-router";
import { updateOrderItemApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/$orderId/items/$itemId")({
	server: {
		handlers: {
			PATCH: ({ request, params }) => updateOrderItemApi(request, params),
		},
	},
});
