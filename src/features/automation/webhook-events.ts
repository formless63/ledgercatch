/**
 * Outbound ledger webhook events (Webhooks capability registry) and payload
 * builders. Payloads carry ids, amounts in minor units and display fields
 * only; never secrets, page bodies or contact details.
 */
import { z } from "zod";
import {
	createWebhookEvent,
	defineWebhookEvents,
} from "#/integrations/webhooks/events";

const id = z.string().uuid();
const minor = z.number().int().nullable();
const currency = z.string().max(8).nullable();
const short = z.string().max(500).nullable();

const order = z.strictObject({
	orderId: id,
	source: z.string().max(64),
	externalOrderId: z.string().max(300),
	merchantName: short,
	orderDate: z.string().max(10).nullable(),
	status: z.string().max(32),
	reviewState: z.string().max(16),
	entityId: id.nullable(),
	categoryId: id.nullable(),
	totalMinor: minor,
	currency,
	url: z.string().max(2048),
});
const claim = z.strictObject({
	claimId: id,
	status: z.string().max(16),
	payerEntityId: id,
	owingEntityId: id,
	currency: z.string().max(8),
	totalMinor: z.number().int(),
	reference: short,
	submittedAt: z.string().nullable(),
	paidAt: z.string().nullable(),
	url: z.string().max(2048),
});
const exportEvent = z.strictObject({
	exportId: id,
	connectionId: id,
	orderId: id.nullable(),
	entityId: id.nullable(),
	amountMinor: minor,
	status: z.string().max(16),
	remoteId: short,
	remoteUrl: z.string().max(2048).nullable(),
	error: z.string().max(1000).nullable(),
});
const capture = z.strictObject({
	captureId: id,
	source: z.string().max(64),
	channel: z.string().max(32),
	kind: z.string().max(32),
	status: z.string().max(16),
	error: z.string().max(1000).nullable(),
	pageUrl: z.string().max(2048),
	url: z.string().max(2048),
});

export const ledgerWebhookEvents = defineWebhookEvents({
	"order.created": order,
	"order.filed": order,
	"order.assigned": order,
	"claim.created": claim,
	"claim.paid": claim,
	"export.sent": exportEvent,
	"export.failed": exportEvent,
	"capture.failed": capture,
	"endpoint.test": z.strictObject({ message: z.string().max(200) }),
});

export type LedgerWebhookType = keyof typeof ledgerWebhookEvents;
export type LedgerWebhookPayload<T extends LedgerWebhookType> = z.input<
	(typeof ledgerWebhookEvents)[T]
>;
export const LEDGER_WEBHOOK_TYPES = Object.keys(ledgerWebhookEvents).filter(
	(type) => type !== "endpoint.test",
) as Exclude<LedgerWebhookType, "endpoint.test">[];

const clip = (value: string | null | undefined, max: number) =>
	value == null ? null : value.slice(0, max);
const appLink = (baseUrl: string | undefined, path: string) =>
	`${(baseUrl ?? "").replace(/\/+$/, "")}${path}`;
const iso = (value: Date | string | null | undefined) =>
	value == null
		? null
		: typeof value === "string"
			? value
			: value.toISOString();

export function buildOrderPayload(
	row: {
		id: string;
		source: string;
		externalOrderId: string;
		merchantName: string | null;
		orderDate: string | null;
		status: string;
		reviewState: string;
		entityId: string | null;
		categoryId: string | null;
		totalMinor: number | null;
		currency: string | null;
	},
	baseUrl?: string,
): LedgerWebhookPayload<"order.created"> {
	return {
		orderId: row.id,
		source: row.source.slice(0, 64),
		externalOrderId: row.externalOrderId.slice(0, 300),
		merchantName: clip(row.merchantName, 500),
		orderDate: row.orderDate,
		status: row.status,
		reviewState: row.reviewState,
		entityId: row.entityId,
		categoryId: row.categoryId,
		totalMinor: row.totalMinor,
		currency: row.currency,
		url: appLink(baseUrl, `/app/orders/${row.id}`),
	};
}

export function buildClaimPayload(
	row: {
		id: string;
		status: string;
		payerEntityId: string;
		owingEntityId: string;
		currency: string;
		totalMinor: number;
		reference: string | null;
		submittedAt: Date | string | null;
		paidAt: Date | string | null;
	},
	baseUrl?: string,
): LedgerWebhookPayload<"claim.created"> {
	return {
		claimId: row.id,
		status: row.status,
		payerEntityId: row.payerEntityId,
		owingEntityId: row.owingEntityId,
		currency: row.currency,
		totalMinor: row.totalMinor,
		reference: clip(row.reference, 500),
		submittedAt: iso(row.submittedAt),
		paidAt: iso(row.paidAt),
		url: appLink(baseUrl, "/app/reimbursements"),
	};
}

export function buildExportPayload(row: {
	id: string;
	connectionId: string;
	orderId: string | null;
	entityId: string | null;
	amountMinor: number | null;
	status: string;
	remoteId: string | null;
	remoteUrl: string | null;
	error: string | null;
}): LedgerWebhookPayload<"export.sent"> {
	return {
		exportId: row.id,
		connectionId: row.connectionId,
		orderId: row.orderId,
		entityId: row.entityId,
		amountMinor: row.amountMinor,
		status: row.status,
		remoteId: clip(row.remoteId, 500),
		remoteUrl: clip(row.remoteUrl, 2048),
		error: clip(row.error, 1000),
	};
}

export function buildCapturePayload(
	row: {
		id: string;
		source: string;
		channel: string;
		kind: string;
		status: string;
		error: string | null;
		pageUrl: string;
	},
	baseUrl?: string,
): LedgerWebhookPayload<"capture.failed"> {
	return {
		captureId: row.id,
		source: row.source.slice(0, 64),
		channel: row.channel.slice(0, 32),
		kind: row.kind.slice(0, 32),
		status: row.status,
		error: clip(row.error, 1000),
		pageUrl: row.pageUrl.slice(0, 2048),
		url: appLink(baseUrl, "/app/captures"),
	};
}

/** Validate and serialize one event (throws WebhookVerificationError on bad data). */
export function buildLedgerWebhook<T extends LedgerWebhookType>(
	type: T,
	payload: LedgerWebhookPayload<T>,
) {
	return createWebhookEvent(ledgerWebhookEvents, type, payload);
}

/** Endpoint subscription filter: an empty list subscribes to every event. */
export function endpointWants(events: readonly string[], type: string) {
	return events.length === 0 || events.includes(type);
}
