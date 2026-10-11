import { createFileRoute } from "@tanstack/react-router";
import {
	getReimbursementsApi,
	setReimbursementApi,
} from "#/features/agent-api/rest.server";

export const Route = createFileRoute("/api/v1/reimbursements")({
	server: {
		handlers: {
			GET: ({ request }) => getReimbursementsApi(request),
			POST: ({ request }) => setReimbursementApi(request),
		},
	},
});
