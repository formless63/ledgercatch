import { createFileRoute } from "@tanstack/react-router";
import {
	createEntityApi,
	listEntitiesApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/entities/")({
	server: {
		handlers: {
			GET: ({ request }) => listEntitiesApi(request),
			POST: ({ request }) => createEntityApi(request),
		},
	},
});
