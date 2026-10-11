/** Shared helpers: read an import's stored file and build its preview. */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { readDocumentBytes } from "#/features/ledger/documents.server";
import { documents } from "#/features/ledger/schema";
import { importTemplates } from "../schema";
import { detectMapping } from "./presets";
import { ImportFileError, readSpreadsheet, splitHeader } from "./read.server";
import {
	type ImportMapping,
	type ImportPreview,
	importMappingSchema,
} from "./types";

export const PREVIEW_ROWS = 50;
/** Hard cap on data rows processed per import. */
export const MAX_IMPORT_ROWS = 50_000;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export function parseMapping(value: unknown): ImportMapping | null {
	const parsed = importMappingSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export async function loadImportBytes(ownerId: string, documentId: string) {
	const [doc] = await db
		.select({ storageKey: documents.storageKey })
		.from(documents)
		.where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)));
	if (!doc) throw new ImportFileError("The uploaded file is no longer stored");
	return readDocumentBytes(doc.storageKey);
}

/** Reads the header and first rows, detects a template/preset. */
export async function previewSpreadsheet(input: {
	ownerId: string;
	bytes: Uint8Array;
	fileName: string;
	sheet?: string | null;
}): Promise<{
	preview: ImportPreview;
	mapping: ImportMapping;
	templateId: string | null;
}> {
	const read = await readSpreadsheet(input.bytes, input.fileName, {
		sheet: input.sheet,
		maxRows: MAX_IMPORT_ROWS + 25,
	});
	if (!read.rows.length) throw new ImportFileError("No rows found in the file");
	const { headerRow, headers, data } = splitHeader(read.rows);
	const templates = await db
		.select()
		.from(importTemplates)
		.where(eq(importTemplates.ownerId, input.ownerId));
	const detection = detectMapping(headers, templates, parseMapping);
	return {
		preview: {
			sheets: read.sheets,
			sheet: read.sheet,
			headerRow,
			headers,
			rows: data.slice(0, PREVIEW_ROWS),
			totalRows: Math.min(data.length, MAX_IMPORT_ROWS),
			format: read.format,
			detected: detection.detected,
		},
		mapping: detection.mapping,
		templateId: detection.templateId,
	};
}
