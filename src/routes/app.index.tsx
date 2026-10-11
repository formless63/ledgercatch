import { createFileRoute } from "@tanstack/react-router";
import { InboxPage } from "#/components/orders/inbox-page";

export const Route = createFileRoute("/app/")({
	component: InboxPage,
});
