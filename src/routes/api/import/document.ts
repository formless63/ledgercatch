import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/import/document")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const { uploadImportDocuments } = await import(
					"#/features/ingress/documents/upload-http.server"
				);
				return uploadImportDocuments(request);
			},
		},
	},
});
