import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/documents/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const { uploadDocumentFromUi } = await import(
					"#/features/ledger/documents-http.server"
				);
				return uploadDocumentFromUi(request);
			},
		},
	},
});
