import { createFileRoute } from "@tanstack/react-router";
import {
	createCategoryApi,
	listCategoriesApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/categories/")({
	server: {
		handlers: {
			GET: ({ request }) => listCategoriesApi(request),
			POST: ({ request }) => createCategoryApi(request),
		},
	},
});
