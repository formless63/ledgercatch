import { createFileRoute } from "@tanstack/react-router";
import { updateCategoryApi } from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/categories/$categoryId")({
	server: {
		handlers: {
			PATCH: ({ request, params }) => updateCategoryApi(request, params),
		},
	},
});
