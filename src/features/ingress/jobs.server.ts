import { z } from "zod";

export const ingressTickPayload = z.object({}).passthrough();
export const ingressPollPayload = z.object({ sourceId: z.string().uuid() });
export const importProcessPayload = z.object({ importId: z.string().uuid() });
export const enrichmentProviderPayload = z.object({
	taskId: z.string().uuid(),
});

/** Scheduled every few minutes: enqueue polls for sources that are due. */
export async function handleIngressTick() {
	const { enqueueDuePolls } = await import("./poll.server");
	const { sweepStuckExports } = await import(
		"#/features/ledger/maintenance.server"
	);
	const [polls, exportsSwept] = await Promise.all([
		enqueueDuePolls(),
		sweepStuckExports(),
	]);
	// Pipeline maintenance (src/features/ops): low-rate, isolated so a failure
	// here never blocks polling or the export sweeper.
	const { autoReparseTick } = await import("#/features/ops/reparse.server");
	const { compactCapturesTick } = await import(
		"#/features/ops/compaction.server"
	);
	const reparse = await autoReparseTick().catch(() => ({
		reparseQueued: 0,
		reparseError: true,
	}));
	const compaction = await compactCapturesTick().catch(() => ({
		compacted: 0,
		compactedBytes: 0,
		compactionError: true,
	}));
	return { ...polls, ...exportsSwept, ...reparse, ...compaction };
}

export async function handleIngressPoll(
	payload: z.output<typeof ingressPollPayload>,
) {
	const { pollSource } = await import("./poll.server");
	return pollSource(payload.sourceId);
}

export async function handleImportProcess(
	payload: z.output<typeof importProcessPayload>,
) {
	const { processImport } = await import("./imports/process.server");
	return processImport(payload.importId);
}

export async function handleEnrichmentProvider(
	payload: z.output<typeof enrichmentProviderPayload>,
) {
	const { runProviderEnrichment } = await import(
		"./enrichment/provider.server"
	);
	return runProviderEnrichment(payload.taskId);
}
