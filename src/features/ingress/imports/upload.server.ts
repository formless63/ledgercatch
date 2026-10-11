import { apiErrorResponse } from "#/integrations/api-platform/responses";
import { readMultipart } from "#/lib/multipart.server";
/** POST /api/imports/upload — session-authenticated spreadsheet upload. */

import { db } from "#/db";
import { storeDocument } from "#/features/ledger/documents.server";
import { auth } from "#/lib/auth";
import { imports } from "../schema";
import { MAX_IMPORT_BYTES, previewSpreadsheet } from "./files.server";
import { ImportFileError, SPREADSHEET_EXTENSIONS } from "./read.server";

export async function handleImportUpload(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	const ownerId = session?.user?.id;
	if (!ownerId)
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (
		Number(request.headers.get("content-length") ?? 0) >
		MAX_IMPORT_BYTES + 65_536
	)
		return Response.json(
			{ error: "File too large (max 25 MB)" },
			{ status: 413 },
		);
	let form: FormData;
	try {
		form = await readMultipart(request, MAX_IMPORT_BYTES + 65_536);
	} catch (error) {
		return apiErrorResponse(error);
	}
	const file = form?.get("file");
	if (!(file instanceof File))
		return Response.json({ error: "Expected a file" }, { status: 400 });
	if (file.size === 0 || file.size > MAX_IMPORT_BYTES)
		return Response.json(
			{ error: "File is empty or larger than 25 MB" },
			{ status: 413 },
		);
	const fileName = (file.name || "import.csv").slice(0, 250);
	if (!SPREADSHEET_EXTENSIONS.test(fileName))
		return Response.json(
			{ error: "Upload a .csv, .tsv, .txt or .xlsx file" },
			{ status: 415 },
		);
	const bytes = new Uint8Array(await file.arrayBuffer());
	try {
		const { preview, mapping, templateId } = await previewSpreadsheet({
			ownerId,
			bytes,
			fileName,
		});
		const stored = await storeDocument({
			ownerId,
			bytes,
			contentType: file.type,
			fileName,
			kind: "other",
		});
		const [row] = await db
			.insert(imports)
			.values({
				ownerId,
				documentId: stored.id,
				fileName,
				source: mapping.source,
				templateId,
				status: "uploaded",
				preview,
				mapping,
				rowCount: preview.totalRows,
			})
			.returning({ id: imports.id });
		return Response.json({ importId: row?.id }, { status: 201 });
	} catch (error) {
		if (error instanceof ImportFileError)
			return Response.json({ error: error.message }, { status: 422 });
		throw error;
	}
}
