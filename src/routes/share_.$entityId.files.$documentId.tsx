import { createFileRoute } from "@tanstack/react-router";

/** Grantee document download: verifies an active share for (viewer, entity). */
export const Route = createFileRoute("/share_/$entityId/files/$documentId")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { downloadSharedDocument } = await import(
					"#/features/sharing/sharing-http.server"
				);
				return downloadSharedDocument(
					request,
					params.entityId,
					params.documentId,
				);
			},
		},
	},
});
