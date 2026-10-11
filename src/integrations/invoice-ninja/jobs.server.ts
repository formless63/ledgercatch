import { z } from "zod";
import { defineJob } from "../jobs/types";
import type { createInvoiceNinja } from "./service.server";
import { uuid } from "./validation";
export function createInvoiceNinjaJobs(
	service: ReturnType<typeof createInvoiceNinja>,
) {
	const queue = {
		deleteAfterSeconds: 86400,
		expireInSeconds: 45,
		retryDelay: 30,
		retryLimit: 5,
		retryBackoff: true,
		retryDelayMax: 900,
	};
	return {
		"invoice-ninja.operation": defineJob({
			payload: z.strictObject({ operationId: uuid }),
			queue,
			handler: async (payload, ctx) =>
				service.runOperation(
					payload.operationId,
					ctx?.signal,
					(ctx?.retryCount ?? 5) >= (ctx?.retryLimit ?? 5),
				),
		}),
		"invoice-ninja.receipt": defineJob({
			payload: z.strictObject({ inboxId: uuid }),
			queue,
			handler: async (payload, ctx) =>
				service.runReceipt(
					payload.inboxId,
					ctx?.signal,
					(ctx?.retryCount ?? 5) >= (ctx?.retryLimit ?? 5),
				),
		}),
	};
}
