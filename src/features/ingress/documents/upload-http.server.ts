/**
 * Session-authenticated multipart upload for the Import → Documents page.
 *
 * Form fields: `file` (repeatable, PDF/PNG/JPEG/WebP ≤ 25 MB each, ≤ 10 per
 * request), `kind` (invoice|receipt, default invoice), `source` (store id,
 * default generic). Each file is stored as a document and becomes a
 * kind "document" capture on channel "upload" (idempotent by sha256).
 */
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { storeDocument } from "#/features/ledger/documents.server";
import { documents } from "#/features/ledger/schema";
import { apiErrorResponse } from "#/integrations/api-platform/responses";
import { auth } from "#/lib/auth";
import { readMultipart } from "#/lib/multipart.server";
import { MAX_DOCUMENT_BYTES, storeIdSchema } from "#/shared/capture";
import { createServerCapture } from "../captures.server";
import { sniffContentType } from "./extract.server";

export const MAX_FILES_PER_UPLOAD = 10;
const ACCEPTED = new Set([
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/webp",
]);

export type UploadResult = {
	fileName: string;
	ok: boolean;
	error?: string;
	captureId?: string;
	documentId?: string;
	/** False when this exact file was uploaded before. */
	created?: boolean;
};

export async function uploadImportDocuments(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	const userId = session?.user?.id;
	if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
	let form: FormData;
	try {
		form = await readMultipart(
			request,
			MAX_DOCUMENT_BYTES * MAX_FILES_PER_UPLOAD + 262_144,
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
	if (!form)
		return Response.json(
			{ error: "Expected multipart form data" },
			{ status: 400 },
		);
	const files = form.getAll("file").filter((f): f is File => f instanceof File);
	if (files.length === 0)
		return Response.json({ error: "No files" }, { status: 400 });
	if (files.length > MAX_FILES_PER_UPLOAD)
		return Response.json(
			{ error: `At most ${MAX_FILES_PER_UPLOAD} files per upload` },
			{ status: 400 },
		);
	const kind = form.get("kind") === "receipt" ? "receipt" : "invoice";
	// Optional hints from the mobile capture page; shown in the review screen.
	const textField = (name: string) => {
		const value = form.get(name);
		return typeof value === "string" ? value.trim().slice(0, 500) : "";
	};
	const noteField = textField("note");
	const merchantHint = textField("merchantHint");
	const entityHint = textField("entityId");
	const source = storeIdSchema
		.catch("generic")
		.parse(form.get("source") ?? "generic");

	const results: UploadResult[] = [];
	for (const file of files) {
		const fileName = file.name || "document";
		if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES) {
			results.push({
				fileName,
				ok: false,
				error: "File is empty or larger than 25 MB",
			});
			continue;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const type = sniffContentType(bytes);
		if (type === "image/heic") {
			results.push({
				fileName,
				ok: false,
				error:
					"HEIC photos are not supported — export as JPEG and upload again",
			});
			continue;
		}
		if (!type || !ACCEPTED.has(type)) {
			results.push({
				fileName,
				ok: false,
				error: "Only PDF, PNG, JPEG or WebP files",
			});
			continue;
		}
		try {
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const stored = await storeDocument({
				ownerId: userId,
				bytes,
				contentType: type,
				fileName,
				kind,
				source,
			});
			const capture = await createServerCapture({
				ownerId: userId,
				channel: "upload",
				kind: "document",
				sourceRef: sha256,
				source,
				pageType: kind === "invoice" ? "invoice" : "unknown",
				pageUrl: `upload:${fileName}`.slice(0, 2000),
				pageTitle: fileName,
				documentId: stored.id,
				bodyText: null,
				note: noteField || null,
				bodyJson:
					merchantHint || entityHint
						? { hints: { merchant: merchantHint, entityId: entityHint } }
						: null,
			});
			await db
				.update(documents)
				.set({ captureId: capture.captureId })
				.where(and(eq(documents.id, stored.id), isNull(documents.captureId)));
			results.push({
				fileName,
				ok: true,
				captureId: capture.captureId,
				documentId: stored.id,
				created: capture.created,
			});
		} catch (error) {
			results.push({
				fileName,
				ok: false,
				error: error instanceof Error ? error.message : "Upload failed",
			});
		}
	}
	const anyOk = results.some((r) => r.ok);
	return Response.json({ results }, { status: anyOk ? 201 : 400 });
}
