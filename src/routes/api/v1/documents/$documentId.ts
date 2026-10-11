import { createFileRoute } from "@tanstack/react-router";
import { downloadDocumentApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/documents/$documentId")({
	server: {
		handlers: {
			GET: ({ request, params }) => downloadDocumentApi(request, params),
		},
	},
});
