import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { db } from "#/db";
import { captureHealthFailure } from "#/integrations/observability/http.server";
import { serviceMetadata } from "#/integrations/observability/runtime.server";

export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: async () => {
				try {
					await db.execute(sql`select 1`);
					return Response.json({
						status: "ok",
						...serviceMetadata(),
						checks: { database: "ok" },
					});
				} catch (error) {
					captureHealthFailure(error);
					return Response.json(
						{
							status: "unhealthy",
							...serviceMetadata(),
							checks: { database: "failed" },
						},
						{ status: 503 },
					);
				}
			},
		},
	},
});
