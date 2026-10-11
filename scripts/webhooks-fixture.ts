import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyWebhookRequest } from "../src/integrations/webhooks/inbound.server";
import type {
	WebhookEvent,
	WebhookRegistry,
} from "../src/integrations/webhooks/events";

/** Disposable local HTTP sender/receiver, never a normal application service. */
export async function webhookFixture(
	registry: WebhookRegistry,
	secrets: string[],
) {
	const attempts: {
		body: Buffer;
		id: string;
		signature: string;
		timestamp: string;
		method?: string;
		contentType?: string;
	}[] = [];
	let status = 204;
	let handoff:
		| ((event: WebhookEvent<WebhookRegistry>) => Promise<void>)
		| undefined;
	let failures = 0;
	let delayMs = 0;
	let responseBytes = 0;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		attempts.push({
			body,
			id: String(req.headers["webhook-id"]),
			signature: String(req.headers["webhook-signature"]),
			timestamp: String(req.headers["webhook-timestamp"]),
			method: req.method,
			contentType: req.headers["content-type"],
		});
		const headers = new Headers();
		for (const [key, value] of Object.entries(req.headers))
			if (value)
				headers.set(key, Array.isArray(value) ? value.join(" ") : value);
		try {
			const event = await verifyWebhookRequest(
				new Request("http://fixture.local", { method: "POST", headers, body }),
				{ registry, secrets },
			);
			await handoff?.(event);
		} catch {
			res.writeHead(401).end();
			return;
		}
		const code = failures-- > 0 ? 500 : status;
		const requestDelay = delayMs;
		const requestResponseBytes = responseBytes;
		if (requestDelay)
			await new Promise((resolve) => setTimeout(resolve, requestDelay));
		res.writeHead(code, { location: "http://127.0.0.1:1/never-follow" });
		res.end(
			requestResponseBytes
				? Buffer.alloc(requestResponseBytes, 120)
				: undefined,
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`;
	return {
		url,
		attempts,
		setHandoff(callback: typeof handoff) {
			handoff = callback;
		},
		configure(options: {
			status?: number;
			failures?: number;
			delayMs?: number;
			responseBytes?: number;
		}) {
			status = options.status ?? 204;
			failures = options.failures ?? 0;
			delayMs = options.delayMs ?? 0;
			responseBytes = options.responseBytes ?? 0;
			attempts.length = 0;
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) =>
					error &&
					(error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
						? reject(error)
						: resolve(),
				),
			);
		},
	};
}
