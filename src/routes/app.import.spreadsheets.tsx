import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SpreadsheetImportPage } from "#/components/imports/spreadsheet-import-page";

export const spreadsheetImportSearchSchema = z.object({
	import: z.string().uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/app/import/spreadsheets")({
	validateSearch: spreadsheetImportSearchSchema,
	component: SpreadsheetImportRoute,
});

function SpreadsheetImportRoute() {
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<SpreadsheetImportPage
			selectedId={search.import}
			onSelect={(id) =>
				void navigate({ search: (prev) => ({ ...prev, import: id }) })
			}
		/>
	);
}
