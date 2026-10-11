/** Server implementations for the spreadsheet import UI (owner-scoped). */
import { and, desc, eq } from "drizzle-orm";
import { db } from "#/db";
import { requireUser } from "#/features/ledger/ledger.server";
import { sendJob } from "#/integrations/jobs/client.server";
import { imports, importTemplates } from "../schema";
import {
	loadImportBytes,
	parseMapping,
	previewSpreadsheet,
} from "./files.server";
import { headerSignature } from "./presets";
import type { ImportMapping, ImportPreview } from "./types";

async function ownedImport(ownerId: string, id: string) {
	const [row] = await db
		.select()
		.from(imports)
		.where(and(eq(imports.id, id), eq(imports.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

function summary(row: typeof imports.$inferSelect) {
	const preview = (row.preview ?? {}) as Partial<ImportPreview>;
	return {
		id: row.id,
		fileName: row.fileName,
		source: row.source,
		status: row.status,
		rowCount: row.rowCount,
		ordersCreated: row.ordersCreated,
		ordersUpdated: row.ordersUpdated,
		error: row.error,
		createdAt: row.createdAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
		documentId: row.documentId,
		detected: preview.detected ?? null,
		stats: preview.stats ?? null,
		errors: preview.errors ?? [],
	};
}
export type ImportSummary = ReturnType<typeof summary>;

export async function listImports() {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(imports)
		.where(eq(imports.ownerId, user.id))
		.orderBy(desc(imports.createdAt))
		.limit(50);
	return rows.map(summary);
}

export async function getImport(id: string) {
	const user = await requireUser();
	const row = await ownedImport(user.id, id);
	const preview = (row.preview ?? null) as ImportPreview | null;
	return {
		...summary(row),
		templateId: row.templateId,
		preview: preview
			? {
					sheets: preview.sheets ?? [],
					sheet: preview.sheet ?? null,
					headerRow: preview.headerRow ?? 0,
					headers: preview.headers ?? [],
					rows: preview.rows ?? [],
					totalRows: preview.totalRows ?? 0,
					format: preview.format ?? "csv",
				}
			: null,
		mapping: parseMapping(row.mapping),
	};
}

/** Re-read the file using another worksheet and re-detect the mapping. */
export async function changeImportSheet(input: { id: string; sheet: string }) {
	const user = await requireUser();
	const row = await ownedImport(user.id, input.id);
	if (row.status === "processing") throw new Error("Import is running");
	if (!row.documentId) throw new Error("The uploaded file is no longer stored");
	const bytes = await loadImportBytes(user.id, row.documentId);
	const { preview, mapping, templateId } = await previewSpreadsheet({
		ownerId: user.id,
		bytes,
		fileName: row.fileName,
		sheet: input.sheet,
	});
	await db
		.update(imports)
		.set({
			preview,
			mapping,
			templateId,
			source: mapping.source,
			rowCount: preview.totalRows,
			status: "uploaded",
		})
		.where(eq(imports.id, row.id));
	return { ok: true };
}

async function insertTemplate(
	ownerId: string,
	name: string,
	headers: string[],
	mapping: ImportMapping,
) {
	const signature = headerSignature(headers);
	const [existing] = await db
		.select({ id: importTemplates.id })
		.from(importTemplates)
		.where(
			and(eq(importTemplates.ownerId, ownerId), eq(importTemplates.name, name)),
		);
	if (existing) {
		await db
			.update(importTemplates)
			.set({
				source: mapping.source,
				headerSignature: signature,
				mapping,
				options: {},
				updatedAt: new Date(),
			})
			.where(eq(importTemplates.id, existing.id));
		return existing.id;
	}
	const [row] = await db
		.insert(importTemplates)
		.values({
			ownerId,
			name,
			source: mapping.source,
			headerSignature: signature,
			mapping,
			options: {},
		})
		.returning({ id: importTemplates.id });
	return row?.id ?? null;
}

export async function saveImportTemplate(input: {
	id: string;
	name: string;
	mapping: ImportMapping;
}) {
	const user = await requireUser();
	const row = await ownedImport(user.id, input.id);
	const headers = (row.preview as Partial<ImportPreview> | null)?.headers ?? [];
	const templateId = await insertTemplate(
		user.id,
		input.name.trim(),
		headers,
		input.mapping,
	);
	await db
		.update(imports)
		.set({ templateId, mapping: input.mapping })
		.where(eq(imports.id, row.id));
	return { templateId };
}

/** Save the mapping and enqueue imports.process. */
export async function startImport(input: {
	id: string;
	mapping: ImportMapping;
}) {
	const user = await requireUser();
	const row = await ownedImport(user.id, input.id);
	if (row.status === "processing") throw new Error("Import is already running");
	const fields = input.mapping.fields;
	if (!fields.externalOrderId && !fields.total && !fields.title)
		throw new Error("Map at least an order ID, a total or an item title");
	await db
		.update(imports)
		.set({
			mapping: input.mapping,
			source: input.mapping.source,
			status: "mapped",
			error: null,
			finishedAt: null,
		})
		.where(eq(imports.id, row.id));
	await sendJob("imports.process", { importId: row.id });
	return { queued: true };
}

export async function deleteImport(id: string) {
	const user = await requireUser();
	const row = await ownedImport(user.id, id);
	if (row.status === "processing") throw new Error("Import is running");
	await db.delete(imports).where(eq(imports.id, row.id));
	return { ok: true };
}

export async function listImportTemplates() {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(importTemplates)
		.where(eq(importTemplates.ownerId, user.id))
		.orderBy(importTemplates.name);
	return rows.flatMap((row) => {
		const mapping = parseMapping(row.mapping);
		return mapping
			? [
					{
						id: row.id,
						name: row.name,
						source: row.source,
						mapping,
						updatedAt: row.updatedAt.toISOString(),
					},
				]
			: [];
	});
}

export async function deleteImportTemplate(id: string) {
	const user = await requireUser();
	await db
		.delete(importTemplates)
		.where(
			and(eq(importTemplates.id, id), eq(importTemplates.ownerId, user.id)),
		);
	return { ok: true };
}
