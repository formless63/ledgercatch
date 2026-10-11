import { z } from "zod";

export const captureProcessPayload = z.object({ captureId: z.string().uuid() });
export const exportPushPayload = z.object({
	exportId: z.string().uuid(),
	skipFuzzyDuplicateCheck: z.boolean().default(false),
});

// Handlers import lazily so the registry stays light for web-process producers.
export async function handleCaptureProcess(
	payload: z.output<typeof captureProcessPayload>,
) {
	const { processCapture } = await import("./process.server");
	return processCapture(payload.captureId);
}

export async function handleExportPush(
	payload: z.output<typeof exportPushPayload>,
) {
	const { pushExport } = await import("./export-push.server");
	return pushExport(payload.exportId, payload.skipFuzzyDuplicateCheck);
}
