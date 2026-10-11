import { createFileRoute } from "@tanstack/react-router";
import {
	errorResponse,
	publicResponse,
} from "../../../../../integrations/invoice-ninja/http.server";
import { applicationInvoiceNinja } from "../../../../../lib/invoice-ninja.server";
export const Route = createFileRoute(
	"/api/integrations/invoice-ninja/webhooks/$connection/$event",
)({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				try {
					return publicResponse(
						await applicationInvoiceNinja.receive(
							request,
							params.connection,
							params.event,
						),
					);
				} catch (error) {
					return errorResponse(error);
				}
			},
		},
	},
});
