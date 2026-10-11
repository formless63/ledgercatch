import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { CapturePage } from "#/components/capture/capture-page";

const searchSchema = z.object({
	/** Comma-separated capture ids created by the share-target POST. */
	shared: z
		.string()
		.regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,9}$/i)
		.optional()
		.catch(undefined),
	sharedFailed: z.coerce
		.number()
		.int()
		.min(0)
		.max(100)
		.optional()
		.catch(undefined),
});

export const Route = createFileRoute("/app/capture")({
	validateSearch: searchSchema,
	head: () => ({ meta: [{ title: "Capture receipt" }] }),
	server: {
		handlers: {
			// Web Share Target (manifest share_target → POST /app/capture).
			POST: async ({ request }) => {
				const { handleShareTarget } = await import(
					"#/features/capture/share.server"
				);
				return handleShareTarget(request);
			},
		},
	},
	component: CaptureRoute,
});

function CaptureRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const onSharedHandled = useCallback(
		() => void navigate({ search: {}, replace: true }),
		[navigate],
	);
	return (
		<CapturePage
			shared={search.shared ? search.shared.split(",") : []}
			sharedFailed={search.sharedFailed}
			onSharedHandled={onSharedHandled}
		/>
	);
}
