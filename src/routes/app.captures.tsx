import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CapturesPage } from "#/components/captures/captures-page";
import { captureListInput } from "#/features/ledger/inputs";
import { STORE_IDS } from "#/shared/capture";

export const capturesSearchSchema = z.object({
	status: captureListInput.shape.status.catch(undefined),
	source: z.enum(STORE_IDS).optional().catch(undefined),
	capture: z.string().uuid().optional().catch(undefined),
	page: z.number().int().min(0).optional().catch(undefined),
});
export type CapturesSearch = z.infer<typeof capturesSearchSchema>;

export const Route = createFileRoute("/app/captures")({
	validateSearch: capturesSearchSchema,
	component: CapturesRoute,
});

function CapturesRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<CapturesPage
			search={search}
			onSearch={(next) =>
				void navigate({
					search: (prev) => ({ ...prev, ...next }),
					replace: true,
				})
			}
		/>
	);
}
