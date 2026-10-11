import { createFileRoute } from "@tanstack/react-router";
import { splitOrderApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/$orderId/split")({
	server: {
		handlers: {
			POST: ({ request, params }) => splitOrderApi(request, params),
		},
	},
});
