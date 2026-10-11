import { createFileRoute } from "@tanstack/react-router";
import { uploadDocumentApi } from "#/features/ledger/extension-api.server";

export const Route = createFileRoute("/api/v1/documents")({
	server: { handlers: { POST: ({ request }) => uploadDocumentApi(request) } },
});
