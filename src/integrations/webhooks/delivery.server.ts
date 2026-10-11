import { isIP } from "node:net";
import { parseWebhookEvent, type WebhookRegistry } from "./events";
import { bounded, DEFAULT_BODY_BYTES, signWebhook } from "./protocol.server";

export type DeliveryCategory =
	| "target"
	| "policy"
	| "configuration"
	| "event"
	| "network"
	| "timeout"
	| "http"
	| "redirect";
export class WebhookDeliveryError extends Error {
	constructor(
		readonly category: DeliveryCategory,
		readonly retryable: boolean,
		readonly status?: number,
	) {
		super(`Webhook delivery failed: ${category}`);
		this.name = "WebhookDeliveryError";
	}
}
export interface TargetPolicy {
	/** Only trusted development/test fixtures may enable this. */
	development?: boolean;
	/** Application-owned DNS/network boundary; must reject by throwing. */
	validate?: (url: URL, signal?: AbortSignal) => void | Promise<void>;
}
export interface WebhookTarget {
	url: string;
	signingSecret: string;
	policy?: TargetPolicy;
}
export interface WebhookDelivery {
	targetRef: string;
	eventId: string;
	eventType: string;
	body: string;
}
export interface DeliveryOptions {
	registry: WebhookRegistry;
	resolveTarget: (
		targetRef: string,
		signal?: AbortSignal,
	) => Promise<WebhookTarget> | WebhookTarget;
	timeoutMs?: number;
	maxBodyBytes?: number;
	onResult?: (facts: {
		operation: "outbound";
		eventType: string;
		outcome: "success" | "permanent" | "retryable";
		status?: number;
		category?: DeliveryCategory;
		durationMs: number;
	}) => void | Promise<void>;
}
function unsafeLiteral(host: string) {
	if (isIP(host) === 4) {
		const [a = 0, b = 0] = host.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	// Reject mapped and special IPv6 ranges; public unicast must be in 2000::/3.
	if (isIP(host) === 6)
		return !/^[23][0-9a-f]{3}:/.test(host) || /^2001:db8:/i.test(host);
	return false;
}
export async function validateWebhookTarget(
	target: WebhookTarget,
	signal?: AbortSignal,
) {
	let url: URL;
	try {
		url = new URL(target.url);
	} catch {
		throw new WebhookDeliveryError("policy", false);
	}
	const host = url.hostname
		.replace(/^\[|\]$/g, "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (
		!["https:", ...(target.policy?.development ? ["http:"] : [])].includes(
			url.protocol,
		) ||
		url.username ||
		url.password ||
		url.href.includes("#") ||
		(!target.policy?.development &&
			([
				"localhost",
				"localhost.localdomain",
				"localhost6",
				"localhost6.localdomain6",
				"ip6-localhost",
				"ip6-loopback",
			].includes(host) ||
				host.endsWith(".localhost") ||
				host.endsWith(".local") ||
				unsafeLiteral(host)))
	)
		throw new WebhookDeliveryError("policy", false);
	try {
		await target.policy?.validate?.(new URL(url), signal);
	} catch {
		throw new WebhookDeliveryError("policy", false);
	}
	return url;
}
export function classifyWebhookStatus(status: number) {
	if (status >= 200 && status < 300) return undefined;
	if (status >= 300 && status < 400)
		return new WebhookDeliveryError("redirect", false, status);
	return new WebhookDeliveryError(
		"http",
		[408, 425, 429].includes(status) || status >= 500,
		status,
	);
}
export async function deliverWebhook(
	delivery: WebhookDelivery,
	options: DeliveryOptions,
) {
	const started = performance.now();
	let status: number | undefined;
	let failure: WebhookDeliveryError | undefined;
	try {
		let maximum: number, timeout: number;
		try {
			maximum = bounded(
				options.maxBodyBytes ?? DEFAULT_BODY_BYTES,
				1,
				1024 * 1024,
			);
			timeout = bounded(options.timeoutMs ?? 10_000, 100, 30_000);
		} catch {
			throw new WebhookDeliveryError("configuration", false);
		}
		const controller = new AbortController();
		const signal = controller.signal;
		const deadlineAt = started + timeout;
		const assertWithinDeadline = () => {
			if (signal.aborted || performance.now() >= deadlineAt) {
				controller.abort();
				throw new WebhookDeliveryError("timeout", true);
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		const attempt = async () => {
			try {
				if (Buffer.byteLength(delivery.body) > maximum) throw new Error();
				const event = parseWebhookEvent(
					JSON.parse(delivery.body),
					options.registry,
				);
				if (
					Buffer.byteLength(delivery.body) > maximum ||
					event.id !== delivery.eventId ||
					event.type !== delivery.eventType
				)
					throw new Error();
			} catch {
				throw new WebhookDeliveryError("event", false);
			}
			let target: WebhookTarget;
			try {
				target = await options.resolveTarget(delivery.targetRef, signal);
			} catch (error) {
				if (error instanceof WebhookDeliveryError) throw error;
				throw new WebhookDeliveryError("target", true);
			}
			assertWithinDeadline();
			const url = await validateWebhookTarget(target, signal);
			assertWithinDeadline();
			const timestamp = Math.floor(Date.now() / 1000);
			const bytes = Buffer.from(delivery.body, "utf8");
			let signature: string;
			try {
				signature = signWebhook(
					delivery.eventId,
					timestamp,
					bytes,
					target.signingSecret,
				);
			} catch {
				throw new WebhookDeliveryError("configuration", false);
			}
			assertWithinDeadline();
			try {
				const response = await fetch(url, {
					method: "POST",
					redirect: "manual",
					signal,
					headers: {
						"content-type": "application/json",
						"webhook-id": delivery.eventId,
						"webhook-timestamp": String(timestamp),
						"webhook-signature": signature,
					},
					body: bytes,
				});
				status = response.status;
				// Status is the entire contract; never read remote content.
				void response.body?.cancel().catch(() => {});
				const error = classifyWebhookStatus(status);
				if (error) throw error;
			} catch (error) {
				if (error instanceof WebhookDeliveryError) throw error;
				throw new WebhookDeliveryError(
					signal.aborted ? "timeout" : "network",
					true,
				);
			}
			return { outcome: "success" as const, status };
		};
		try {
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						controller.abort();
						reject(new WebhookDeliveryError("timeout", true));
					},
					Math.max(0, deadlineAt - performance.now()),
				);
			});
			return await Promise.race([attempt(), deadline]);
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	} catch (error) {
		failure =
			error instanceof WebhookDeliveryError
				? error
				: new WebhookDeliveryError("target", true);
		throw failure;
	} finally {
		// Optional telemetry/audit sink must never cause an acknowledged delivery to retry.
		try {
			if (Object.hasOwn(options.registry, delivery.eventType))
				await options.onResult?.({
					operation: "outbound",
					eventType: delivery.eventType,
					outcome: failure
						? failure.retryable
							? "retryable"
							: "permanent"
						: "success",
					status,
					category: failure?.category,
					durationMs: performance.now() - started,
				});
		} catch {
			/* application sink failure is isolated */
		}
	}
}
