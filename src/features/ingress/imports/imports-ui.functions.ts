/**
 * Server functions for the spreadsheet import page. Implementations are
 * lazy-imported so server code never reaches the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { importMappingSchema } from "./types";

const importsUi = () => import("./imports-ui.server");
const idInput = z.object({ id: z.string().uuid() });

export const listImports = createServerFn({ method: "GET" }).handler(async () =>
	(await importsUi()).listImports(),
);

export const getImport = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await importsUi()).getImport(data.id));

export const changeImportSheet = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string().uuid(), sheet: z.string().max(300) }))
	.handler(async ({ data }) => (await importsUi()).changeImportSheet(data));

export const startImport = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string().uuid(), mapping: importMappingSchema }))
	.handler(async ({ data }) => (await importsUi()).startImport(data));

export const saveImportTemplate = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string().uuid(),
			name: z.string().trim().min(1).max(120),
			mapping: importMappingSchema,
		}),
	)
	.handler(async ({ data }) => (await importsUi()).saveImportTemplate(data));

export const deleteImport = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await importsUi()).deleteImport(data.id));

export const listImportTemplates = createServerFn({ method: "GET" }).handler(
	async () => (await importsUi()).listImportTemplates(),
);

export const deleteImportTemplate = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) =>
		(await importsUi()).deleteImportTemplate(data.id),
	);
