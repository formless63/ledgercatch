import { createFileRoute } from "@tanstack/react-router";
import { lookupOrdersApi } from "#/features/ledger/extension-api.server";

export const Route = createFileRoute("/api/v1/orders/lookup")({
	server: { handlers: { POST: ({ request }) => lookupOrdersApi(request) } },
});
