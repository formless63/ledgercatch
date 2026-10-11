import { createFileRoute } from "@tanstack/react-router";
import { listCapturesApi } from "#/features/agent-api/rest.server";
import { createCaptureApi } from "#/features/ledger/extension-api.server";

export const Route = createFileRoute("/api/v1/captures")({
	server: {
		handlers: {
			// GET lists captures (agent API, ledger:read); /captures/list is an alias.
			GET: ({ request }) => listCapturesApi(request),
			POST: ({ request }) => createCaptureApi(request),
		},
	},
});
