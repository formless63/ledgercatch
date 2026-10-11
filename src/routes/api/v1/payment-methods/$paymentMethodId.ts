import { createFileRoute } from "@tanstack/react-router";
import { updatePaymentMethodApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute(
	"/api/v1/payment-methods/$paymentMethodId",
)({
	server: {
		handlers: {
			PATCH: ({ request, params }) => updatePaymentMethodApi(request, params),
		},
	},
});
