import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/documents/$documentId")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { downloadDocument } = await import(
					"#/features/ledger/documents-http.server"
				);
				return downloadDocument(request, params.documentId);
			},
		},
	},
});
