import { createFileRoute } from "@tanstack/react-router";
import {
	createOrdersApi,
	listOrdersApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/")({
	server: {
		handlers: {
			GET: ({ request }) => listOrdersApi(request),
			POST: ({ request }) => createOrdersApi(request),
		},
	},
});
