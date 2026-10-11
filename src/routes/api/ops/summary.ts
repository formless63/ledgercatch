import { createFileRoute } from "@tanstack/react-router";
import { opsResponse } from "#/lib/ops.server";
export const Route = createFileRoute("/api/ops/summary")({
	server: { handlers: { GET: ({ request }) => opsResponse(request) } },
});
