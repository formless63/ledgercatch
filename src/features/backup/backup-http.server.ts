/** Session-authenticated download of a finished "export everything" archive. */
import { db } from "#/db";
import { env } from "#/env";
import {
	appendAuditEvent,
	createAuditActor,
	createAuditSubject,
} from "#/integrations/audit-log/audit.server";
import { auth } from "#/lib/auth";
import { getApplicationStorage } from "#/lib/storage.server";
import { findReadyArchiveForOwner } from "./export.server";

export async function downloadExportArchive(
	request: Request,
	archiveId: string,
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) return new Response("Unauthorized", { status: 401 });
	if (!/^[0-9a-f-]{36}$/i.test(archiveId))
		return new Response("Not found", { status: 404 });
	const archive = await findReadyArchiveForOwner(session.user.id, archiveId);
	if (!archive?.storageKey) return new Response("Not found", { status: 404 });
	const object = await getApplicationStorage().getObject(archive.storageKey, {
		signal: request.signal,
	});
	const body = object.body as
		| { transformToWebStream?: () => ReadableStream<Uint8Array> }
		| undefined;
	if (!body?.transformToWebStream)
		return new Response("Archive unavailable", { status: 502 });
	await appendAuditEvent(db, {
		actor: createAuditActor("user", session.user.id),
		action: "backup.export_downloaded",
		subject: createAuditSubject("export_archive", archive.id),
		outcome: "success",
		metadata: null,
	}).catch(() => {});
	const slug =
		env.APP_NAME.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "export";
	const date = (archive.completedAt ?? archive.createdAt)
		.toISOString()
		.slice(0, 10);
	const headers: Record<string, string> = {
		"content-type": "application/zip",
		"content-disposition": `attachment; filename="${slug}-export-${date}.zip"`,
		"cache-control": "private, no-store",
		"x-content-type-options": "nosniff",
	};
	const length = object.contentLength ?? archive.sizeBytes;
	if (length) headers["content-length"] = String(length);
	return new Response(body.transformToWebStream(), { headers });
}
