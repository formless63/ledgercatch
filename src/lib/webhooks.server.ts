import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { webhookEndpoints } from "../features/automation/schema";
import { ledgerWebhookEvents } from "../features/automation/webhook-events";
import { decryptSecret } from "../features/connectors/crypto.server";
import {
	type TargetPolicy,
	WebhookDeliveryError,
	type WebhookTarget,
} from "../integrations/webhooks/delivery.server";
import { createWebhookJobs } from "../integrations/webhooks/jobs.server";

export const ENDPOINT_TARGET_PREFIX = "endpoint:";

/**
 * Operator opt-in for LAN consumers (n8n, Home Assistant): allows http and
 * private/loopback hosts. Off by default; public HTTPS only otherwise.
 */
export function endpointPolicy(): TargetPolicy | undefined {
	return process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === "true"
		? { development: true }
		: undefined;
}

/** Resolve a job's opaque targetRef to the endpoint's current URL and secret. */
export async function resolveWebhookTarget(
	targetRef: string,
): Promise<WebhookTarget> {
	if (targetRef === "reference") {
		if (
			!process.env.WEBHOOK_REFERENCE_URL ||
			!process.env.WEBHOOK_REFERENCE_SECRET
		)
			throw new WebhookDeliveryError("target", false);
		return {
			url: process.env.WEBHOOK_REFERENCE_URL,
			signingSecret: process.env.WEBHOOK_REFERENCE_SECRET,
		};
	}
	const id = targetRef.startsWith(ENDPOINT_TARGET_PREFIX)
		? targetRef.slice(ENDPOINT_TARGET_PREFIX.length)
		: "";
	if (!/^[0-9a-f-]{36}$/.test(id))
		throw new WebhookDeliveryError("target", false);
	const [row] = await db
		.select()
		.from(webhookEndpoints)
		.where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.enabled, true)))
		.limit(1);
	if (!row) throw new WebhookDeliveryError("target", false);
	let signingSecret: string;
	try {
		signingSecret = decryptSecret<string>(row.secretCiphertext);
	} catch {
		throw new WebhookDeliveryError("configuration", false);
	}
	return { url: row.url, signingSecret, policy: endpointPolicy() };
}

export const applicationWebhookJobs = createWebhookJobs({
	registry: ledgerWebhookEvents,
	resolveTarget: resolveWebhookTarget,
});
