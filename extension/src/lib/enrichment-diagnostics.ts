/** Opt-in recorder evidence stays local and is never ingested as an order. */
import type { EnrichmentTask } from "@app/shared/capture";
import { STORE_IDS } from "@app/shared/capture";
import { browser } from "wxt/browser";
import { z } from "zod";
import type { FetchFacts } from "./enrichment";
import { getSettings } from "./settings";
import { byteLength, truncateToBytes } from "./util";

export const ENRICHMENT_DIAGNOSTIC_KEY = "enrichmentDiagnostic";
export const ENRICHMENT_DIAGNOSTIC_ALARM = "enrichment-diagnostic-expiry";
export const DIAGNOSTIC_MAX_BYTES = 512 * 1024;
export const DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1000;

const schema = z.object({
	version: z.literal(1),
	capturedAt: z.number(),
	expiresAt: z.number(),
	source: z.enum(STORE_IDS),
	taskId: z.string(),
	externalOrderId: z.string(),
	via: z.enum(["fetch", "tab"]),
	status: z.number(),
	finalUrl: z.string(),
	redirected: z.boolean(),
	contentType: z.string(),
	originalHtmlBytes: z.number(),
	html: z.string(),
	truncated: z.boolean(),
});
export type EnrichmentDiagnostic = z.infer<typeof schema>;

function diagnosticUrl(raw: string) {
	try {
		const url = new URL(raw);
		url.username = "";
		url.password = "";
		url.hash = "";
		const safeParams = new URLSearchParams();
		for (const key of ["orderId", "tradeOrderId"])
			if (/^\d{1,30}$/.test(url.searchParams.get(key) ?? "")) safeParams.set(key, url.searchParams.get(key) ?? "");
		url.search = safeParams.toString();
		return url.toString().slice(0, 2048);
	} catch {
		return "";
	}
}

/** Cap the entire serialized record, including JSON escaping and metadata. */
export function buildEnrichmentDiagnostic(task: EnrichmentTask, facts: FetchFacts, via: "fetch" | "tab", now: number) {
	const record: EnrichmentDiagnostic = {
		version: 1,
		capturedAt: now,
		expiresAt: now + DIAGNOSTIC_TTL_MS,
		source: task.source,
		taskId: task.id.slice(0, 120),
		externalOrderId: task.externalOrderId.slice(0, 120),
		via,
		status: facts.status,
		finalUrl: diagnosticUrl(facts.finalUrl),
		redirected: facts.redirected,
		contentType: facts.contentType.slice(0, 120),
		originalHtmlBytes: byteLength(facts.html),
		html: truncateToBytes(facts.html, DIAGNOSTIC_MAX_BYTES),
		truncated: byteLength(facts.html) > DIAGNOSTIC_MAX_BYTES,
	};
	let encoded = JSON.stringify(record);
	if (byteLength(encoded) <= DIAGNOSTIC_MAX_BYTES) return encoded;
	record.truncated = true;
	let low = 0;
	let high = byteLength(record.html);
	const html = record.html;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		record.html = truncateToBytes(html, mid);
		if (byteLength(JSON.stringify(record)) <= DIAGNOSTIC_MAX_BYTES) low = mid;
		else high = mid - 1;
	}
	record.html = truncateToBytes(html, low);
	encoded = JSON.stringify(record);
	return encoded;
}

export async function clearEnrichmentDiagnostic() {
	await browser.storage.local.remove(ENRICHMENT_DIAGNOSTIC_KEY);
	await browser.alarms.clear(ENRICHMENT_DIAGNOSTIC_ALARM);
}

export async function readEnrichmentDiagnostic(now = Date.now()): Promise<EnrichmentDiagnostic | null> {
	const stored = (await browser.storage.local.get(ENRICHMENT_DIAGNOSTIC_KEY))[ENRICHMENT_DIAGNOSTIC_KEY];
	if (typeof stored !== "string") return null;
	if (byteLength(stored) > DIAGNOSTIC_MAX_BYTES) {
		await clearEnrichmentDiagnostic();
		return null;
	}
	try {
		const result = schema.safeParse(JSON.parse(stored));
		if (
			result.success &&
			result.data.expiresAt > now &&
			result.data.capturedAt <= now &&
			result.data.expiresAt - result.data.capturedAt <= DIAGNOSTIC_TTL_MS
		)
			return result.data;
	} catch {
		/* Invalid or expired evidence is discarded, never logged. */
	}
	await clearEnrichmentDiagnostic();
	return null;
}

export async function rememberEnrichmentFailure(
	recorderMode: boolean,
	task: EnrichmentTask,
	facts: FetchFacts,
	via: "fetch" | "tab",
	now = Date.now(),
) {
	if (!recorderMode) return;
	if (!(await getSettings()).recorderMode) return;
	await browser.storage.local.set({ [ENRICHMENT_DIAGNOSTIC_KEY]: buildEnrichmentDiagnostic(task, facts, via, now) });
	// Recorder mode can change while a run or storage write is in flight.
	if (!(await getSettings()).recorderMode) {
		await clearEnrichmentDiagnostic();
		return;
	}
	await browser.alarms.create(ENRICHMENT_DIAGNOSTIC_ALARM, { when: now + DIAGNOSTIC_TTL_MS });
}
