import type { z } from "zod";
import {
	afterCaptureProcessed,
	afterExportPushed,
	automationTickPayload,
	budgetsEvaluatePayload,
	handleAutomationTick,
	handleBudgetsEvaluate,
	handlePaperlessPush,
	paperlessPushPayload,
} from "../../features/automation/jobs.server";
import {
	exportArchivePayload,
	handleExportArchive,
} from "../../features/backup/jobs.server";
import {
	enrichmentProviderPayload,
	handleEnrichmentProvider,
	handleImportProcess,
	handleIngressPoll,
	handleIngressTick,
	importProcessPayload,
	ingressPollPayload,
	ingressTickPayload,
} from "../../features/ingress/jobs.server";
import {
	captureProcessPayload,
	exportPushPayload,
	handleCaptureProcess,
	handleExportPush,
} from "../../features/ledger/jobs.server";
import {
	handleTrackingRefresh,
	trackingRefreshPayload,
} from "../../features/lifecycle/jobs.server";
import {
	fxRefreshPayload,
	handleFxRefresh,
	handleReconcile,
	reconcilePayload,
} from "../../features/money/jobs.server";
import { applicationInvoiceNinjaJobs } from "../../lib/invoice-ninja.server";
import { applicationNotificationJobs } from "../../lib/notifications.server";
import { applicationWebhookJobs } from "../../lib/webhooks.server";
import { handleHealthProbe, healthProbePayload } from "./tasks/health-probe";
import { defineJob, type JobDefinition, type JobHandlerContext } from "./types";

/** Capability jobs with application post-handler hooks. */
const invoiceNinjaJobs = {
	"invoice-ninja.operation": withAfter(
		applicationInvoiceNinjaJobs["invoice-ninja.operation"],
		syncPaidClaimsQuietly,
	),
	"invoice-ninja.receipt": withAfter(
		applicationInvoiceNinjaJobs["invoice-ninja.receipt"],
		syncPaidClaimsQuietly,
	),
};
const webhookJobs = {
	"webhooks.deliver": {
		...applicationWebhookJobs["webhooks.deliver"],
		handler: async (
			payload: Parameters<
				(typeof applicationWebhookJobs)["webhooks.deliver"]["handler"]
			>[0],
			context?: JobHandlerContext,
		) => {
			const { recordDelivery } = await import(
				"../../features/automation/webhooks.server"
			);
			try {
				const result = await applicationWebhookJobs["webhooks.deliver"].handler(
					payload,
					context,
				);
				const failed = "outcome" in result && result.outcome === "permanent";
				await recordDelivery(payload.targetRef, {
					ok: !failed,
					detail:
						failed && "category" in result ? String(result.category) : null,
				});
				return result;
			} catch (error) {
				await recordDelivery(payload.targetRef, {
					ok: false,
					detail: error instanceof Error ? error.message : "retrying",
				});
				throw error;
			}
		},
	},
};

function withAfter<T extends JobDefinition<z.ZodType>>(
	job: T,
	after: () => Promise<void>,
): T {
	return {
		...job,
		handler: async (payload, context) => {
			const result = await job.handler(payload, context);
			await after();
			return result;
		},
	};
}
async function syncPaidClaimsQuietly() {
	const { syncPaidClaims } = await import(
		"../../features/automation/invoice-ninja.server"
	);
	await syncPaidClaims().catch(() => {});
}

export const jobRegistry = {
	...invoiceNinjaJobs,
	...webhookJobs,
	...applicationNotificationJobs,
	"automation.tick": defineJob({
		payload: automationTickPayload,
		queue: {
			deleteAfterSeconds: 86_400,
			expireInSeconds: 600,
			retryDelay: 60,
			retryLimit: 0,
		},
		handler: handleAutomationTick,
	}),
	"budgets.evaluate": defineJob({
		payload: budgetsEvaluatePayload,
		queue: {
			deleteAfterSeconds: 86_400,
			expireInSeconds: 120,
			retryDelay: 30,
			retryLimit: 2,
		},
		handler: handleBudgetsEvaluate,
	}),
	"paperless.push": defineJob({
		payload: paperlessPushPayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 300,
			retryDelay: 120,
			retryLimit: 4,
			retryBackoff: true,
			retryDelayMax: 3_600,
		},
		handler: handlePaperlessPush,
	}),
	"health.probe": defineJob({
		payload: healthProbePayload,
		queue: {
			deleteAfterSeconds: 86_400,
			expireInSeconds: 60,
			retryDelay: 1,
			retryLimit: 0,
		},
		handler: handleHealthProbe,
	}),
	"captures.process": defineJob({
		payload: captureProcessPayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 300,
			retryDelay: 15,
			retryLimit: 3,
			retryBackoff: true,
		},
		handler: async (payload) => {
			const startedAt = new Date();
			const result = await handleCaptureProcess(payload);
			// Webhooks, alerts and budget evaluation never fail the capture job.
			await afterCaptureProcessed(payload.captureId, startedAt).catch(() => {});
			return result;
		},
	}),
	"exports.push": defineJob({
		payload: exportPushPayload,
		queue: {
			deleteAfterSeconds: 30 * 86_400,
			expireInSeconds: 300,
			retryDelay: 60,
			retryLimit: 5,
			retryBackoff: true,
			retryDelayMax: 3_600,
		},
		handler: async (payload) => {
			try {
				return await handleExportPush(payload);
			} finally {
				await afterExportPushed(payload.exportId).catch(() => {});
			}
		},
	}),
	"ingress.tick": defineJob({
		payload: ingressTickPayload,
		queue: {
			deleteAfterSeconds: 3_600,
			expireInSeconds: 120,
			retryDelay: 30,
			retryLimit: 0,
		},
		handler: handleIngressTick,
	}),
	"ingress.poll": defineJob({
		payload: ingressPollPayload,
		queue: {
			deleteAfterSeconds: 86_400,
			expireInSeconds: 600,
			retryDelay: 60,
			retryLimit: 2,
			retryBackoff: true,
		},
		handler: handleIngressPoll,
	}),
	"imports.process": defineJob({
		payload: importProcessPayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 900,
			retryDelay: 30,
			retryLimit: 1,
		},
		handler: handleImportProcess,
	}),
	"enrichment.provider": defineJob({
		payload: enrichmentProviderPayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 300,
			retryDelay: 120,
			retryLimit: 3,
			retryBackoff: true,
		},
		handler: handleEnrichmentProvider,
	}),
	"tracking.refresh": defineJob({
		payload: trackingRefreshPayload,
		queue: {
			deleteAfterSeconds: 86_400,
			expireInSeconds: 600,
			retryDelay: 300,
			retryLimit: 1,
		},
		handler: handleTrackingRefresh,
	}),
	"money.reconcile": defineJob({
		payload: reconcilePayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 300,
			retryDelay: 60,
			retryLimit: 1,
		},
		handler: handleReconcile,
	}),
	"money.fx_refresh": defineJob({
		payload: fxRefreshPayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 300,
			retryDelay: 600,
			retryLimit: 3,
			retryBackoff: true,
		},
		handler: handleFxRefresh,
	}),
	"backup.export": defineJob({
		payload: exportArchivePayload,
		queue: {
			deleteAfterSeconds: 7 * 86_400,
			expireInSeconds: 3_600,
			retryDelay: 60,
			retryLimit: 1,
		},
		handler: handleExportArchive,
	}),
} as const;

export type JobName = keyof typeof jobRegistry;
export type JobPayload<TName extends JobName> = z.input<
	(typeof jobRegistry)[TName]["payload"]
>;

export function parseJobPayload<TName extends JobName>(
	name: TName,
	payload: unknown,
) {
	return jobRegistry[name].payload.parse(payload) as Parameters<
		(typeof jobRegistry)[TName]["handler"]
	>[0];
}
