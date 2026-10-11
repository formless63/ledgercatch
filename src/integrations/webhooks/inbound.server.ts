import {
	parseWebhookEvent,
	type WebhookEvent,
	type WebhookRegistry,
} from "./events";
import {
	bounded,
	DEFAULT_BODY_BYTES,
	readBoundedBody,
	verifyWebhookSignature,
	WebhookVerificationError,
} from "./protocol.server";

export interface VerifyWebhookOptions<R extends WebhookRegistry> {
	registry: R;
	secrets: readonly string[];
	toleranceSeconds?: number;
	maxBodyBytes?: number;
	readTimeoutMs?: number;
}
export async function verifyWebhookRequest<R extends WebhookRegistry>(
	request: Request,
	options: VerifyWebhookOptions<R>,
): Promise<WebhookEvent<R>> {
	if (request.bodyUsed) throw new WebhookVerificationError("body-read");
	const maximum = bounded(
		options.maxBodyBytes ?? DEFAULT_BODY_BYTES,
		1,
		1024 * 1024,
	);
	const length = request.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))
		throw new WebhookVerificationError("body-size");
	if (
		request.method !== "POST" ||
		(request.headers.get("content-encoding") ?? "identity") !== "identity"
	)
		throw new WebhookVerificationError("headers");
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedBody(
			request.body,
			maximum,
			AbortSignal.any([
				request.signal,
				AbortSignal.timeout(
					bounded(options.readTimeoutMs ?? 10_000, 100, 30_000),
				),
			]),
		);
	} catch (error) {
		if (error instanceof WebhookVerificationError) throw error;
		throw new WebhookVerificationError("body-read");
	}
	const id = verifyWebhookSignature(bytes, request.headers, options);
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new WebhookVerificationError("event");
	}
	const event = parseWebhookEvent(value, options.registry);
	if (event.id !== id) throw new WebhookVerificationError("event");
	return event;
}
/** Implement with durable event-ID uniqueness and enqueue in ONE application transaction.
 * Return duplicate only after a previous handoff committed; failed enqueue must release/rollback.
 */
export interface WebhookHandoff<E> {
	handoffOnce(
		eventId: string,
		enqueue: () => Promise<E>,
	): Promise<{ duplicate: true } | { duplicate: false; result: E }>;
}
export async function handoffWebhookRequest<R extends WebhookRegistry, T>(
	request: Request,
	options: VerifyWebhookOptions<R>,
	enqueue: (event: WebhookEvent<R>) => Promise<T>,
	idempotency: WebhookHandoff<T>,
) {
	const event = await verifyWebhookRequest(request, options);
	return idempotency.handoffOnce(event.id, () => enqueue(event));
}
