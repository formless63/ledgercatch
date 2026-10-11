import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { ItemsPage } from "#/components/lifecycle/items-page";

export const Route = createFileRoute("/app/items")({
	validateSearch: z.object({
		q: z.string().max(200).optional().catch(undefined),
		key: z.string().max(400).optional().catch(undefined),
	}),
	component: ItemsRoute,
});

function ItemsRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const onSearch = useCallback(
		(next: { q?: string; key?: string }) =>
			void navigate({
				search: (prev) => ({ ...prev, ...next }),
				replace: true,
			}),
		[navigate],
	);
	return (
		<ItemsPage q={search.q ?? ""} selected={search.key} onSearch={onSearch} />
	);
}
