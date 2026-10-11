import type { Notification } from "./schema";
import { NotificationError } from "./validation";
export function ntfyConfig(environment: NodeJS.ProcessEnv = process.env) {
	try {
		if (!environment.NTFY_BASE_URL) throw new Error();
		const url = new URL(environment.NTFY_BASE_URL);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.protocol !== "https:" &&
				!(
					url.protocol === "http:" &&
					["development", "test"].includes(environment.NODE_ENV ?? "") &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
				))
		)
			throw new Error();
		const raw = environment.NTFY_TIMEOUT_SECONDS ?? "10",
			timeout = Number(raw);
		if (
			!/^\d+$/.test(raw) ||
			!Number.isInteger(timeout) ||
			timeout < 1 ||
			timeout > 30
		)
			throw new Error();
		const token = environment.NTFY_TOKEN;
		if (token && /\p{Cc}/u.test(token)) throw new Error();
		return { url: url.toString(), token, timeoutSeconds: timeout };
	} catch {
		throw new NotificationError("configuration");
	}
}
/** Official JSON publish endpoint; topic/current token never enters a Jobs payload. */
export async function publishNtfy(
	notification: Notification,
	topic: string,
	options: {
		signal?: AbortSignal;
		config?: ReturnType<typeof ntfyConfig>;
		fetch?: typeof fetch;
	} = {},
) {
	if (typeof topic !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(topic))
		throw new NotificationError("invalid-input");
	const config = options.config ?? ntfyConfig();
	const signal = options.signal
		? AbortSignal.any([
				options.signal,
				AbortSignal.timeout(config.timeoutSeconds * 1000),
			])
		: AbortSignal.timeout(config.timeoutSeconds * 1000);
	if (signal.aborted)
		return { outcome: "permanent" as const, category: "rejected" as const };
	// ntfy explicitly uses at-least-once HTTP retries; lost responses can duplicate delivery.
	try {
		const response = await (options.fetch ?? fetch)(config.url, {
			method: "POST",
			redirect: "manual",
			signal,
			headers: {
				"Content-Type": "application/json",
				...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
			},
			body: JSON.stringify({
				topic,
				title: notification.title,
				message: notification.body,
			}),
		});
		void response.body?.cancel().catch(() => {});
		if (response.status >= 200 && response.status < 300)
			return { outcome: "delivered" as const };
		const retryable =
			[408, 425, 429].includes(response.status) || response.status >= 500;
		if (retryable) throw new NotificationError("unavailable", true);
		return { outcome: "permanent" as const, category: "rejected" as const };
	} catch (error) {
		if (error instanceof NotificationError) throw error;
		throw new NotificationError("unavailable", true);
	}
}
