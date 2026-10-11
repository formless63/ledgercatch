import { createFileRoute } from "@tanstack/react-router";

// Archives live in private object storage; stream them through the app.
export const Route = createFileRoute("/api/backup/archives/$archiveId")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { downloadExportArchive } = await import(
					"#/features/backup/backup-http.server"
				);
				return downloadExportArchive(request, params.archiveId);
			},
		},
	},
});
