/**
 * Outbound ledger webhooks: user-configured endpoints delivered through the
 * Webhooks capability (`webhooks.deliver` jobs, Standard Webhooks signing,
 * bounded retries). `emitLedgerWebhook` is the single emission helper.
 */
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import {
	decryptSecret,
	encryptSecret,
} from "#/features/connectors/crypto.server";
import {
	deliverWebhook,
	validateWebhookTarget,
	WebhookDeliveryError,
} from "#/integrations/webhooks/delivery.server";
import { generateWebhookSecret } from "#/integrations/webhooks/protocol.server";
import { appName } from "#/lib/app-name";
import { ENDPOINT_TARGET_PREFIX, endpointPolicy } from "#/lib/webhooks.server";
import { endpointInput } from "./inputs";
import { webhookEndpoints } from "./schema";
import {
	buildLedgerWebhook,
	endpointWants,
	LEDGER_WEBHOOK_TYPES,
	type LedgerWebhookPayload,
	type LedgerWebhookType,
	ledgerWebhookEvents,
} from "./webhook-events";

export { endpointInput };

function publicEndpoint(row: typeof webhookEndpoints.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		events: row.events,
		enabled: row.enabled,
		lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
		lastOutcome: row.lastOutcome,
		lastError: row.lastError,
		createdAt: row.createdAt.toISOString(),
	};
}

export async function listEndpointsForOwner(ownerId: string) {
	const rows = await db
		.select()
		.from(webhookEndpoints)
		.where(eq(webhookEndpoints.ownerId, ownerId))
		.orderBy(asc(webhookEndpoints.createdAt));
	return {
		endpoints: rows.map(publicEndpoint),
		eventTypes: LEDGER_WEBHOOK_TYPES,
	};
}

/** Saves an endpoint. Returns the plaintext secret only when one was generated. */
export async function saveEndpointForOwner(
	ownerId: string,
	input: z.output<typeof endpointInput>,
) {
	try {
		await validateWebhookTarget({
			url: input.url,
			signingSecret: "",
			policy: endpointPolicy(),
		});
	} catch {
		throw new Error(
			process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === "true"
				? "Webhook URL must be http(s) without credentials."
				: "Webhook URL must be public HTTPS (private/LAN targets need WEBHOOK_ALLOW_PRIVATE_TARGETS=true).",
		);
	}
	const secret =
		!input.id || input.rotateSecret ? generateWebhookSecret() : undefined;
	const values = {
		name: input.name,
		url: input.url,
		events: [...new Set(input.events)],
		enabled: input.enabled,
		updatedAt: new Date(),
		...(secret ? { secretCiphertext: encryptSecret(secret) } : {}),
	};
	if (input.id) {
		const [row] = await db
			.update(webhookEndpoints)
			.set(values)
			.where(
				and(
					eq(webhookEndpoints.id, input.id),
					eq(webhookEndpoints.ownerId, ownerId),
				),
			)
			.returning();
		if (!row) throw new Error("NOT_FOUND");
		return { endpoint: publicEndpoint(row), secret: secret ?? null };
	}
	const [row] = await db
		.insert(webhookEndpoints)
		.values({ ...values, ownerId, secretCiphertext: encryptSecret(secret) })
		.returning();
	if (!row) throw new Error("Endpoint insert failed");
	return { endpoint: publicEndpoint(row), secret: secret ?? null };
}

export async function deleteEndpointForOwner(ownerId: string, id: string) {
	await db
		.delete(webhookEndpoints)
		.where(
			and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.ownerId, ownerId)),
		);
	return { ok: true };
}

/** Re-reveal the signing secret (owner only) so a consumer can be configured. */
export async function revealEndpointSecretForOwner(
	ownerId: string,
	id: string,
) {
	const [row] = await db
		.select({ secret: webhookEndpoints.secretCiphertext })
		.from(webhookEndpoints)
		.where(
			and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.ownerId, ownerId)),
		);
	if (!row) throw new Error("NOT_FOUND");
	return { secret: decryptSecret<string>(row.secret) };
}

export async function recordDelivery(
	targetRef: string,
	outcome: { ok: boolean; detail: string | null },
) {
	if (!targetRef.startsWith(ENDPOINT_TARGET_PREFIX)) return;
	const id = targetRef.slice(ENDPOINT_TARGET_PREFIX.length);
	if (!/^[0-9a-f-]{36}$/.test(id)) return;
	await db
		.update(webhookEndpoints)
		.set({
			lastDeliveryAt: new Date(),
			lastOutcome: outcome.ok ? "success" : "failed",
			lastError: outcome.ok ? null : (outcome.detail ?? "failed").slice(0, 500),
		})
		.where(eq(webhookEndpoints.id, id))
		.catch(() => {});
}

/** Synchronous test delivery of an `endpoint.test` event (no retries). */
export async function testEndpointForOwner(ownerId: string, id: string) {
	const [row] = await db
		.select({ id: webhookEndpoints.id })
		.from(webhookEndpoints)
		.where(
			and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.ownerId, ownerId)),
		);
	if (!row) throw new Error("NOT_FOUND");
	const { event, body } = buildLedgerWebhook("endpoint.test", {
		message: `Test delivery from ${appName}`,
	});
	const targetRef = `${ENDPOINT_TARGET_PREFIX}${row.id}`;
	try {
		await deliverWebhook(
			{ targetRef, eventId: event.id, eventType: event.type, body },
			{
				registry: ledgerWebhookEvents,
				// Test even when disabled: resolve by id regardless of `enabled`.
				resolveTarget: async () => {
					const [endpoint] = await db
						.select()
						.from(webhookEndpoints)
						.where(eq(webhookEndpoints.id, row.id));
					if (!endpoint) throw new WebhookDeliveryError("target", false);
					return {
						url: endpoint.url,
						signingSecret: decryptSecret<string>(endpoint.secretCiphertext),
						policy: endpointPolicy(),
					};
				},
			},
		);
		await recordDelivery(targetRef, { ok: true, detail: null });
		return { ok: true as const, message: "Delivered (2xx)" };
	} catch (error) {
		const detail =
			error instanceof WebhookDeliveryError
				? `${error.category}${error.status ? ` ${error.status}` : ""}`
				: "failed";
		await recordDelivery(targetRef, { ok: false, detail });
		return { ok: false as const, message: `Delivery failed: ${detail}` };
	}
}

/**
 * Emit one ledger event to every enabled endpoint of `ownerId` subscribed to
 * `type`. Best effort: enqueue failures are swallowed so ledger writes never
 * fail because of webhooks. Call after the domain transaction commits.
 */
export async function emitLedgerWebhook<
	T extends Exclude<LedgerWebhookType, "endpoint.test">,
>(ownerId: string, type: T, payload: LedgerWebhookPayload<T>) {
	try {
		const endpoints = await db
			.select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
			.from(webhookEndpoints)
			.where(
				and(
					eq(webhookEndpoints.ownerId, ownerId),
					eq(webhookEndpoints.enabled, true),
				),
			);
		const targets = endpoints.filter((e) => endpointWants(e.events, type));
		if (targets.length === 0) return { queued: 0 };
		const { event, body } = buildLedgerWebhook(type, payload);
		const { sendJob } = await import("#/integrations/jobs/client.server");
		let queued = 0;
		for (const target of targets) {
			await sendJob("webhooks.deliver", {
				targetRef: `${ENDPOINT_TARGET_PREFIX}${target.id}`,
				eventId: event.id,
				eventType: event.type,
				body,
			});
			queued += 1;
		}
		return { queued };
	} catch {
		return { queued: 0 };
	}
}
