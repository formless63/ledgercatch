/** HTTP client for the user's server. Runs in the service worker. */
import {
	type CaptureEnvelope,
	type EnrichmentNextResponse,
	type EnrichmentResultRequest,
	enrichmentNextResponseSchema,
	enrichmentResultRequestSchema,
	type DocumentUploadMeta,
	type ExtensionStatus,
	type OrderLookupResponse,
	captureResponseSchema,
	extensionStatusSchema,
	orderLookupRequestSchema,
	orderLookupResponseSchema,
} from "@app/shared/capture";
import type { Settings } from "@/lib/settings";
import { errorMessage, normalizeServerUrl } from "@/lib/util";

const REQUEST_TIMEOUT_MS = 60_000;

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly retryAfter: string | null = null,
	) {
		super(message);
		this.name = "HttpError";
	}
}

/** Network-level failure (DNS, refused, CORS, timeout). Always retryable. */
export class NetworkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetworkError";
	}
}

async function request(settings: Settings, path: string, init: RequestInit): Promise<Response> {
	if (!settings.serverUrl || !settings.apiKey) throw new HttpError(0, "Server URL or API key not configured");
	if (!normalizeServerUrl(settings.serverUrl)) throw new HttpError(0, "Use HTTPS for a remote server; HTTP is allowed only on loopback");
	const headers = new Headers(init.headers);
	headers.set("X-API-Key", settings.apiKey);
	headers.set("Accept", "application/json");
	let res: Response;
	try {
		res = await fetch(`${settings.serverUrl}${path}`, {
			...init,
			headers,
			credentials: "omit",
			redirect: "error",
			cache: "no-store",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		throw new NetworkError(errorMessage(err));
	}
	if (!res.ok) {
		let detail = "";
		try {
			detail = (await res.text()).slice(0, 300);
		} catch {
			/* ignore */
		}
		throw new HttpError(res.status, `HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.headers.get("retry-after"));
	}
	return res;
}

async function json(res: Response): Promise<unknown> {
	try {
		return (await res.json()) as unknown;
	} catch {
		throw new HttpError(res.status, "Server returned invalid JSON");
	}
}

export async function getStatus(settings: Settings): Promise<ExtensionStatus> {
	const res = await request(settings, "/api/v1/extension/status", { method: "GET" });
	const parsed = extensionStatusSchema.safeParse(await json(res));
	if (!parsed.success) throw new HttpError(res.status, "Unexpected status response (is this the right server?)");
	return parsed.data;
}

export async function postCapture(settings: Settings, envelope: CaptureEnvelope): Promise<"accepted" | "duplicate"> {
	const res = await request(settings, "/api/v1/captures", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(envelope),
	});
	const parsed = captureResponseSchema.safeParse(await json(res).catch(() => null));
	// A 2xx without a well-formed body still means the server took it.
	return parsed.success ? parsed.data.status : "accepted";
}

export async function postDocument(settings: Settings, meta: DocumentUploadMeta, file: Blob): Promise<void> {
	const form = new FormData();
	form.set("meta", JSON.stringify(meta));
	form.set("file", file, meta.fileName);
	await request(settings, "/api/v1/documents", { method: "POST", body: form });
}

export async function lookupOrders(
	settings: Settings,
	input: { source: CaptureEnvelope["source"]; externalOrderIds: string[] },
): Promise<OrderLookupResponse> {
	const body = orderLookupRequestSchema.parse(input);
	const res = await request(settings, "/api/v1/orders/lookup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const parsed = orderLookupResponseSchema.safeParse(await json(res));
	if (!parsed.success) throw new HttpError(res.status, "Unexpected lookup response");
	return parsed.data;
}

/** Claim up to `limit` enrichment tasks (`limit=0` only returns the pending count). */
export async function nextEnrichmentTasks(
	settings: Settings,
	limit: number,
	skipSources: readonly string[] = [],
): Promise<EnrichmentNextResponse> {
	const params = new URLSearchParams({ limit: String(Math.max(0, Math.floor(limit))) });
	if (skipSources.length) params.set("skipSources", skipSources.join(","));
	const res = await request(settings, `/api/v1/enrichment/next?${params}`, {
		method: "GET",
	});
	const parsed = enrichmentNextResponseSchema.safeParse(await json(res));
	if (!parsed.success) throw new HttpError(res.status, "Unexpected enrichment response");
	return parsed.data;
}

export async function reportEnrichmentResult(
	settings: Settings,
	taskId: string,
	result: EnrichmentResultRequest,
): Promise<void> {
	const body = enrichmentResultRequestSchema.parse(result);
	await request(settings, `/api/v1/enrichment/${encodeURIComponent(taskId)}/result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
