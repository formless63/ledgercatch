import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { DocumentsPage } from "#/components/docassist/documents-page";
import {
	QUEUE_VIEWS,
	type QueueView,
} from "#/features/ingress/documents/inputs";

const searchSchema = z.object({
	view: z.enum(QUEUE_VIEWS).optional().catch(undefined),
	capture: z.string().uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/app/import/documents")({
	validateSearch: searchSchema,
	component: DocumentsRoute,
});

function DocumentsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const onNavigate = useCallback(
		(next: { view?: QueueView; capture?: string | undefined }) =>
			void navigate({
				search: (prev) => ({ ...prev, ...next }),
				replace: true,
			}),
		[navigate],
	);
	return (
		<DocumentsPage
			view={search.view ?? "review"}
			captureId={search.capture}
			onNavigate={onNavigate}
		/>
	);
}
