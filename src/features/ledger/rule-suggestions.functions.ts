import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const core = () => import("./rule-suggestions.server");
async function owner() {
	return (await (await import("./ledger.server")).requireUser()).id;
}
export const listRuleSuggestions = createServerFn({ method: "GET" }).handler(
	async () => (await core()).listRuleSuggestionsForOwner(await owner()),
);
export const acceptRuleSuggestion = createServerFn({ method: "POST" })
	.validator(
		z.object({
			field: z.enum([
				"payment_last4",
				"placed_by_group",
				"ship_to_address",
				"checkout_email_domain",
			]),
			value: z.string().trim().min(1).max(500),
			entityId: z.uuid(),
		}),
	)
	.handler(async ({ data }) =>
		(await core()).acceptRuleSuggestionForOwner(await owner(), data),
	);
