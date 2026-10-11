import { createFileRoute } from "@tanstack/react-router";
import {
	createPaymentMethodApi,
	listPaymentMethodsApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/payment-methods/")({
	server: {
		handlers: {
			GET: ({ request }) => listPaymentMethodsApi(request),
			POST: ({ request }) => createPaymentMethodApi(request),
		},
	},
});
