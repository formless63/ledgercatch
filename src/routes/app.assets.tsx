import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import {
	AssetsPage,
	type AssetsSearch,
} from "#/components/lifecycle/assets-page";
import { ASSET_STATUSES } from "#/features/lifecycle/schema";

export const Route = createFileRoute("/app/assets")({
	validateSearch: z.object({
		status: z.enum(ASSET_STATUSES).optional().catch(undefined),
		entity: z.string().uuid().optional().catch(undefined),
		expiring: z.coerce
			.number()
			.int()
			.min(1)
			.max(3650)
			.optional()
			.catch(undefined),
		q: z.string().max(200).optional().catch(undefined),
	}),
	component: AssetsRoute,
});

function AssetsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const onSearch = useCallback(
		(next: Partial<AssetsSearch>) =>
			void navigate({
				search: (prev) => ({ ...prev, ...next }),
				replace: true,
			}),
		[navigate],
	);
	return <AssetsPage search={search} onSearch={onSearch} />;
}
