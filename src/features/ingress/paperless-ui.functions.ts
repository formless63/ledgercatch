/**
 * Server functions for Paperless-ngx actions in the UI. The implementation
 * lives in sources/paperless.server.ts and is imported lazily.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const pushToPaperlessInput = z.object({
	sourceId: z.string().uuid(),
	documentId: z.string().uuid(),
});

/** Upload one of the user's documents to a Paperless source (needs "Push invoices" on). */
export const pushDocumentToPaperlessFn = createServerFn({ method: "POST" })
	.validator(pushToPaperlessInput)
	.handler(async ({ data }) => {
		const { requireUser } = await import("#/lib/session.server");
		const user = await requireUser();
		const { pushDocumentToPaperless } = await import(
			"./sources/paperless.server"
		);
		return pushDocumentToPaperless(data.sourceId, data.documentId, user.id);
	});
