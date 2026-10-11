/** Server functions for the owner's "export everything" archives. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function owner() {
	const { getRequestHeaders } = await import("@tanstack/react-start/server");
	const { auth } = await import("#/lib/auth");
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!session?.user) throw new Error("UNAUTHORIZED");
	return session.user;
}
const server = () => import("./export.server");

export const listExportArchives = createServerFn({ method: "GET" }).handler(
	async () => (await server()).listExportArchivesForOwner((await owner()).id),
);

export const requestExportArchive = createServerFn({ method: "POST" }).handler(
	async () => (await server()).requestExportArchiveForOwner((await owner()).id),
);

export const deleteExportArchive = createServerFn({ method: "POST" })
	.validator(z.object({ archiveId: z.string().uuid() }))
	.handler(async ({ data }) =>
		(await server()).deleteExportArchiveForOwner(
			(await owner()).id,
			data.archiveId,
		),
	);

/** Download URL served by the route the app mounts (see docs/BACKUP.md). */
export const exportArchiveDownloadPath = (archiveId: string) =>
	`/api/backup/archives/${archiveId}`;
