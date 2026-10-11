import { createFileRoute } from "@tanstack/react-router";

/**
 * Inbound email webhook (push): POST raw MIME. The path token maps to an
 * `inbound_email` ingress source. See docs/INGRESS-EMAIL.md.
 */
export const Route = createFileRoute("/api/inbound/email/$token")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const { handleInboundEmail } = await import(
					"#/features/ingress/email/inbound.server"
				);
				return handleInboundEmail(request, params.token);
			},
		},
	},
});
