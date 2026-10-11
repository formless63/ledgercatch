import { z } from "zod";

/** Payload for the "backup.export" job (register in src/integrations/jobs/registry.ts). */
export const exportArchivePayload = z.object({ archiveId: z.string().uuid() });

// Lazy import keeps the registry light for web-process producers.
export async function handleExportArchive(
	payload: z.output<typeof exportArchivePayload>,
) {
	const { buildExportArchive } = await import("./export.server");
	return buildExportArchive(payload.archiveId);
}
