import { createFileRoute } from "@tanstack/react-router";
import { ImportHub } from "#/components/imports/import-hub";

export const Route = createFileRoute("/app/import/")({
	component: ImportHub,
});
