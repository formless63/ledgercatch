import { z } from "zod";
import { defineJob } from "../jobs/types";
import {
	type DeliveryOptions,
	deliverWebhook,
	WebhookDeliveryError,
} from "./delivery.server";
import { DEFAULT_BODY_BYTES } from "./protocol.server";

export const webhookDeliveryPayload = z.strictObject({
	targetRef: z.string().min(1).max(256),
	eventId: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9_-]+$/),
	eventType: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[a-z][a-z0-9._-]{0,127}$/),
	body: z
		.string()
		.refine((body) => Buffer.byteLength(body) <= DEFAULT_BODY_BYTES),
});
export function createWebhookJobs(options: DeliveryOptions) {
	return {
		"webhooks.deliver": defineJob({
			payload: webhookDeliveryPayload,
			queue: {
				deleteAfterSeconds: 86_400,
				expireInSeconds: 60,
				retryLimit: 5,
				retryDelay: 30,
				retryBackoff: true,
				retryDelayMax: 900,
			},
			handler: async (payload) => {
				try {
					return await deliverWebhook(payload, options);
				} catch (error) {
					if (error instanceof WebhookDeliveryError && !error.retryable)
						return {
							outcome: "permanent",
							category: error.category,
							status: error.status,
						};
					if (error instanceof WebhookDeliveryError) throw error;
					throw new WebhookDeliveryError("event", false);
				}
			},
		}),
	} as const;
}
