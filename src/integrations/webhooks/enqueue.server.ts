import { getJobsClient } from "../jobs/client.server";
import type { WebhookDelivery } from "./delivery.server";
import { webhookDeliveryPayload } from "./jobs.server";

/** Each deliberate enqueue may create work. Domain idempotency is application-owned. */
export async function enqueueWebhook(delivery: WebhookDelivery) {
	const payload = webhookDeliveryPayload.safeParse(delivery);
	if (!payload.success) throw new Error("Invalid webhook job payload");
	const boss = await getJobsClient();
	return { jobId: await boss.send("webhooks.deliver", payload.data) };
}
