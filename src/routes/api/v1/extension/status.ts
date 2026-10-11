import { createFileRoute } from "@tanstack/react-router";
import { extensionStatusApi } from "#/features/ledger/extension-api.server";

export const Route = createFileRoute("/api/v1/extension/status")({
	server: { handlers: { GET: ({ request }) => extensionStatusApi(request) } },
});
