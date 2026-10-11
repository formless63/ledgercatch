import { createFileRoute } from "@tanstack/react-router";
import { createOpenApiDocument } from "#/integrations/api-platform/openapi";

export const Route = createFileRoute("/api/openapi.json")({
	server: {
		handlers: {
			GET: () => Response.json(createOpenApiDocument()),
		},
	},
});
