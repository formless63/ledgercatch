import { apiErrorResponse } from "#/integrations/api-platform/responses";
/** Session-authenticated document download/upload for the web UI. */
import { auth } from "#/lib/auth";
import { readMultipart } from "#/lib/multipart.server";
import { documentKindSchema, MAX_DOCUMENT_BYTES } from "#/shared/capture";
import { readDocumentBytes, storeDocument } from "./documents.server";
import { findOwnedDocument } from "./ledger.server";

async function sessionUserId(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	return session?.user?.id ?? null;
}

const INLINE_TYPES = new Set([
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/webp",
]);

export async function downloadDocument(request: Request, documentId: string) {
	const userId = await sessionUserId(request);
	if (!userId) return new Response("Unauthorized", { status: 401 });
	if (!/^[0-9a-f-]{36}$/i.test(documentId))
		return new Response("Not found", { status: 404 });
	const doc = await findOwnedDocument(userId, documentId);
	if (!doc) return new Response("Not found", { status: 404 });
	const bytes = await readDocumentBytes(doc.storageKey);
	const download = new URL(request.url).searchParams.has("download");
	const inline = !download && INLINE_TYPES.has(doc.contentType);
	// HTML is never rendered inline from our origin.
	const contentType =
		doc.contentType === "text/html"
			? "text/plain; charset=utf-8"
			: doc.contentType;
	return new Response(Buffer.from(bytes), {
		headers: {
			"content-type": contentType,
			"content-length": String(bytes.byteLength),
			"content-disposition": `${inline ? "inline" : "attachment"}; filename="${doc.fileName.replace(/"/g, "")}"`,
			"cache-control": "private, max-age=300",
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox",
		},
	});
}

export async function uploadDocumentFromUi(request: Request) {
	const userId = await sessionUserId(request);
	if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (
		Number(request.headers.get("content-length") ?? 0) >
		MAX_DOCUMENT_BYTES + 65_536
	)
		return Response.json({ error: "File too large" }, { status: 413 });
	let form: FormData;
	try {
		form = await readMultipart(request, MAX_DOCUMENT_BYTES + 65_536);
	} catch (error) {
		return apiErrorResponse(error);
	}
	const file = form?.get("file");
	const orderId = form?.get("orderId");
	const kind = documentKindSchema.safeParse(form?.get("kind") ?? "invoice");
	if (!(file instanceof File) || typeof orderId !== "string" || !kind.success)
		return Response.json(
			{ error: "Expected file, orderId and kind" },
			{ status: 400 },
		);
	if (file.size === 0 || file.size > MAX_DOCUMENT_BYTES)
		return Response.json(
			{ error: "File is empty or too large" },
			{ status: 413 },
		);
	const { getOrderOwner } = await import("./orders-owner.server");
	if ((await getOrderOwner(orderId)) !== userId)
		return Response.json({ error: "Order not found" }, { status: 404 });
	const stored = await storeDocument({
		ownerId: userId,
		bytes: new Uint8Array(await file.arrayBuffer()),
		contentType: file.type,
		fileName: file.name,
		kind: kind.data,
		orderId,
	});
	return Response.json(stored, { status: stored.duplicate ? 200 : 201 });
}
