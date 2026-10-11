import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/imports/upload")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const { handleImportUpload } = await import(
					"#/features/ingress/imports/upload.server"
				);
				return handleImportUpload(request);
			},
		},
	},
});
