import { createFileRoute } from "@tanstack/react-router";
import {
	listOrderDocumentsApi,
	uploadOrderDocumentApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/orders/$orderId/documents")({
	server: {
		handlers: {
			GET: ({ request, params }) => listOrderDocumentsApi(request, params),
			POST: ({ request, params }) => uploadOrderDocumentApi(request, params),
		},
	},
});
