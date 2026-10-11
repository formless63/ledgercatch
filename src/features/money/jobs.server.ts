/**
 * Job payloads + handlers for the money features. Register in
 * src/integrations/jobs/registry.ts:
 *
 * - "money.reconcile" { ownerId, statementImportId? } — run the matcher.
 * - "money.fx_refresh" { backfillDays? } — fetch ECB rates (schedule daily,
 *   e.g. "30 16 * * 1-5" UTC; the ECB publishes around 16:00 CET).
 */
import { z } from "zod";

export const reconcilePayload = z.object({
	ownerId: z.string().min(1),
	statementImportId: z.string().uuid().nullish(),
});

export const fxRefreshPayload = z.object({
	backfillDays: z.number().int().min(0).max(3650).optional(),
});

// Handlers import lazily so the registry stays light for web-process producers.
export async function handleReconcile(
	payload: z.output<typeof reconcilePayload>,
) {
	const { runReconciliation } = await import("./reconcile.server");
	return runReconciliation(payload.ownerId, payload.statementImportId ?? null);
}

export async function handleFxRefresh(
	payload: z.output<typeof fxRefreshPayload>,
) {
	const { refreshFxRates } = await import("./fx.server");
	return refreshFxRates({ backfillDays: payload.backfillDays });
}
