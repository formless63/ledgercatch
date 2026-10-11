/** Session-authenticated document download for share grantees. */
import { auth } from "#/lib/auth";
import { readDocumentBytes } from "../ledger/documents.server";
import {
	auditSharedDownload,
	findSharedDocumentForGrantee,
	requireGrant,
} from "./sharing.server";

export async function downloadSharedDocument(
	request: Request,
	entityId: string,
	documentId: string,
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) return new Response("Unauthorized", { status: 401 });
	const grant = await requireGrant(session.user.id, entityId).catch(() => null);
	if (!grant) return new Response("Not found", { status: 404 });
	const doc = await findSharedDocumentForGrantee(grant, documentId);
	if (!doc) return new Response("Not found", { status: 404 });
	const bytes = await readDocumentBytes(doc.storageKey);
	await auditSharedDownload(grant, doc.id);
	const inline =
		!new URL(request.url).searchParams.has("download") &&
		["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(
			doc.contentType,
		);
	return new Response(Buffer.from(bytes), {
		headers: {
			"content-type":
				doc.contentType === "text/html"
					? "text/plain; charset=utf-8"
					: doc.contentType,
			"content-length": String(bytes.byteLength),
			"content-disposition": `${inline ? "inline" : "attachment"}; filename="${doc.fileName.replace(/["\\\r\n]/g, "")}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox",
		},
	});
}
