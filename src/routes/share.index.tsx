import { createFileRoute } from "@tanstack/react-router";
import { SharedHome } from "#/components/sharing/portal";

export const Route = createFileRoute("/share/")({
	component: SharedHome,
});
