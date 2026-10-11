import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/files/$")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const { fileUiHttp } = await import("../../../lib/file-ui.server");
				return fileUiHttp(request, params._splat ?? "");
			},
			POST: async ({ request, params }) => {
				const { fileUiHttp } = await import("../../../lib/file-ui.server");
				return fileUiHttp(request, params._splat ?? "");
			},
		},
	},
});
