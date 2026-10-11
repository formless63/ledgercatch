/**
 * Bounded fetch for connector providers: timeout, response size cap,
 * same-host-only redirects, secret redaction and readable errors.
 */
import { ConnectorError } from "./types";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface BoundedFetchOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | FormData | Uint8Array;
	timeoutMs?: number;
	maxResponseBytes?: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Strings to scrub from any error message (tokens, keys). */
	secrets?: string[];
	/** Human name of the remote, used in error messages ("custom HTTP"). */
	label: string;
}

export interface BoundedResponse {
	status: number;
	ok: boolean;
	headers: Headers;
	text: string;
	url: string;
}

/** Replace known secrets and token-looking strings with "***". */
export function redact(text: string, secrets: string[] = []): string {
	let out = text;
	for (const s of secrets) {
		if (s && s.length >= 4) out = out.split(s).join("***");
	}
	return out.replace(/(bearer\s+)[^\s"']+/gi, "$1***");
}

/** Short, single-line, tag-free, secret-free remote message. */
export function sanitizeRemoteMessage(
	raw: string,
	secrets: string[] = [],
	max = 200,
): string {
	let msg = raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		const extracted = extractMessage(parsed);
		if (extracted) msg = extracted;
	} catch {
		// not JSON
	}
	msg = msg
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	msg = redact(msg, secrets);
	return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
}

function extractMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const b = body as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof b.message === "string") parts.push(b.message);
	else if (b.error && typeof b.error === "object") {
		const m = (b.error as Record<string, unknown>).message;
		if (typeof m === "string") parts.push(m);
	} else if (typeof b.error === "string") parts.push(b.error);
	if (typeof b.reason === "string") parts.push(b.reason);
	// Laravel-style 422: { errors: { field: ["msg"] } }
	if (b.errors && typeof b.errors === "object") {
		for (const [field, v] of Object.entries(
			b.errors as Record<string, unknown>,
		)) {
			const first = Array.isArray(v) ? v[0] : v;
			if (typeof first === "string") parts.push(`${field}: ${first}`);
		}
	}
	return parts.length ? parts.join("; ") : undefined;
}

/** Map a non-2xx response to a ConnectorError. */
export function httpError(
	res: Pick<BoundedResponse, "status" | "text">,
	label: string,
	secrets: string[] = [],
	authHint?: string,
): ConnectorError {
	const detail = sanitizeRemoteMessage(res.text, secrets);
	const base = `${label} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
	const s = res.status;
	if (s === 401 || s === 403) {
		return new ConnectorError(
			"auth",
			authHint ? `${base}. ${authHint}` : base,
			{
				status: s,
				retryable: false,
			},
		);
	}
	if (s === 408 || s === 429 || s >= 500) {
		return new ConnectorError("remote", base, { status: s, retryable: true });
	}
	if (s === 400 || s === 422) {
		return new ConnectorError("validation", base, {
			status: s,
			retryable: false,
		});
	}
	return new ConnectorError("remote", base, { status: s, retryable: false });
}

export async function boundedFetch(
	url: string,
	opts: BoundedFetchOptions,
): Promise<BoundedResponse> {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const method = (opts.method ?? "GET").toUpperCase();
	const origin = new URL(url);

	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("timeout")),
		timeoutMs,
	);
	const onOuterAbort = () => controller.abort(opts.signal?.reason);
	opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

	try {
		let current = origin;
		for (let hop = 0; ; hop++) {
			let res: Response;
			try {
				res = await doFetch(current.toString(), {
					method,
					headers: opts.headers,
					body: opts.body as BodyInit | undefined,
					redirect: "manual",
					signal: controller.signal,
				});
			} catch (err) {
				throw networkError(err, opts, controller, timeoutMs);
			}

			if (
				res.status >= 300 &&
				res.status < 400 &&
				res.headers.get("location")
			) {
				await res.body?.cancel().catch(() => {});
				const next = new URL(res.headers.get("location") as string, current);
				const sameHost = next.hostname === origin.hostname;
				const downgrade =
					current.protocol === "https:" && next.protocol !== "https:";
				if (!sameHost || downgrade) {
					throw new ConnectorError(
						"validation",
						`${opts.label} redirected to ${next.protocol}//${next.host}; refusing to follow redirects to another host. Check the base URL.`,
						{ status: res.status },
					);
				}
				const methodPreserving = res.status === 307 || res.status === 308;
				if (method !== "GET" && method !== "HEAD" && !methodPreserving) {
					throw new ConnectorError(
						"validation",
						`${opts.label} redirected ${method} ${current.pathname} (HTTP ${res.status}) to ${next.toString()}; update the base URL to the final address.`,
						{ status: res.status },
					);
				}
				if (hop >= MAX_REDIRECTS) {
					throw new ConnectorError(
						"remote",
						`${opts.label}: too many redirects`,
					);
				}
				current = next;
				continue;
			}

			let text: string;
			try {
				text = await readCapped(res, maxBytes, opts.label);
			} catch (err) {
				if (err instanceof ConnectorError) throw err;
				throw networkError(err, opts, controller, timeoutMs);
			}
			return {
				status: res.status,
				ok: res.ok,
				headers: res.headers,
				text,
				url: current.toString(),
			};
		}
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

function networkError(
	err: unknown,
	opts: BoundedFetchOptions,
	controller: AbortController,
	timeoutMs: number,
): ConnectorError {
	if (controller.signal.aborted && !opts.signal?.aborted) {
		return new ConnectorError(
			"network",
			`${opts.label} did not respond within ${Math.round(timeoutMs / 1000)}s`,
			{ retryable: true },
		);
	}
	if (opts.signal?.aborted) {
		return new ConnectorError(
			"network",
			`${opts.label} request was cancelled`,
			{
				retryable: true,
			},
		);
	}
	const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
	const detail =
		cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : "");
	return new ConnectorError(
		"network",
		redact(
			`Could not reach ${opts.label}${detail ? ` (${detail})` : ""}`,
			opts.secrets,
		),
		{ retryable: true },
	);
}

async function readCapped(
	res: Response,
	maxBytes: number,
	label: string,
): Promise<string> {
	const declared = Number(res.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel().catch(() => {});
		throw tooLarge(label, maxBytes);
	}
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw tooLarge(label, maxBytes);
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		buf.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(buf);
}

function tooLarge(label: string, maxBytes: number): ConnectorError {
	return new ConnectorError(
		"remote",
		`${label} response exceeded ${Math.round(maxBytes / 1024 / 1024)} MB`,
		{ retryable: false },
	);
}

export function parseJson<T = unknown>(text: string, label: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ConnectorError(
			"remote",
			`${label} returned a non-JSON response: ${sanitizeRemoteMessage(text, [], 120)}`,
		);
	}
}
