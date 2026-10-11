import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type VerificationCategory =
	| "configuration"
	| "headers"
	| "timestamp"
	| "signature"
	| "body-size"
	| "body-read"
	| "event";
export class WebhookVerificationError extends Error {
	constructor(readonly category: VerificationCategory) {
		super(`Webhook verification failed: ${category}`);
		this.name = "WebhookVerificationError";
	}
}
export function bounded(value: number, minimum: number, maximum: number) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
		throw new WebhookVerificationError("configuration");
	return value;
}
export function generateWebhookSecret() {
	return `whsec_${randomBytes(32).toString("base64")}`;
}
function secretBytes(secret: string) {
	const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
		throw new WebhookVerificationError("configuration");
	const bytes = Buffer.from(encoded, "base64");
	if (
		bytes.length < 24 ||
		bytes.length > 64 ||
		bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
	)
		throw new WebhookVerificationError("configuration");
	return bytes;
}
export function validMessageId(id: string) {
	return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
function digest(
	id: string,
	timestamp: string,
	body: Uint8Array,
	secret: string,
) {
	return createHmac("sha256", secretBytes(secret))
		.update(`${id}.${timestamp}.`)
		.update(body)
		.digest();
}
export function signWebhook(
	id: string,
	timestamp: number,
	body: Uint8Array,
	secret: string,
) {
	if (!validMessageId(id) || !Number.isSafeInteger(timestamp) || timestamp < 0)
		throw new WebhookVerificationError("headers");
	return `v1,${digest(id, String(timestamp), body, secret).toString("base64")}`;
}
export function verifyWebhookSignature(
	body: Uint8Array,
	headers: Headers,
	options: {
		secrets: readonly string[];
		toleranceSeconds?: number;
		now?: number;
	},
) {
	const id = headers.get("webhook-id") ?? "";
	const timestamp = headers.get("webhook-timestamp") ?? "";
	const signatures = headers.get("webhook-signature") ?? "";
	if (
		!validMessageId(id) ||
		!/^(0|[1-9][0-9]{0,10})$/.test(timestamp) ||
		!signatures ||
		signatures.length > 4096
	)
		throw new WebhookVerificationError("headers");
	const tolerance = bounded(options.toleranceSeconds ?? 300, 1, 900);
	const now = options.now ?? Math.floor(Date.now() / 1000);
	if (
		!Number.isSafeInteger(now) ||
		Math.abs(now - Number(timestamp)) > tolerance
	)
		throw new WebhookVerificationError("timestamp");
	if (!options.secrets.length || options.secrets.length > 8)
		throw new WebhookVerificationError("configuration");
	const candidates = signatures
		.split(" ")
		.filter((s) => /^v1,[A-Za-z0-9+/]{43}=$/.test(s))
		.map((s) => Buffer.from(s.slice(3), "base64"));
	let matches = 0;
	// No early return: compare every supported candidate with every configured secret.
	for (const secret of options.secrets) {
		const expected = digest(id, timestamp, body, secret);
		for (const candidate of candidates)
			if (candidate.length === expected.length)
				matches |= Number(timingSafeEqual(candidate, expected));
	}
	if (!matches) throw new WebhookVerificationError("signature");
	return id;
}
export const DEFAULT_BODY_BYTES = 64 * 1024;
export async function readBoundedBody(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	signal?: AbortSignal,
) {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		while (true) {
			const result = await reader.read();
			signal?.throwIfAborted();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > limit) {
				void reader.cancel().catch(() => {});
				throw new WebhookVerificationError("body-size");
			}
			chunks.push(result.value);
		}
		return Buffer.concat(chunks, size);
	} finally {
		signal?.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
