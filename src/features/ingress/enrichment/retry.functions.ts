import { createServerFn } from "@tanstack/react-start";
export const retryFailedEnrichment = createServerFn({ method: "POST" }).handler(
	async () => {
		const { requireUser } = await import("#/lib/session.server");
		const { retryFailedEnrichmentForOwner } = await import("./retry.server");
		return retryFailedEnrichmentForOwner((await requireUser()).id);
	},
);
