/**
 * Background enrichment: the server queues order-detail pages for orders it
 * only knows partially (e.g. from an email). We fetch each page with the
 * user's store session from the service worker, queue it as an html_snapshot
 * capture (trigger "backfill") through the normal outbox, and report back.
 *
 * Throttled to one request per store domain every 3 s and 20 pages per run.
 * A signed-out / rate-limited answer stops that store for the rest of the run.
 */
import type { EnrichmentTask } from "@app/shared/capture";
import { browser } from "wxt/browser";
import {
	CLIENT_RENDERED_STORES,
	checkTask,
	classifyFetch,
	DomainThrottle,
	htmlTitle,
	MAX_FETCHES_PER_RUN,
	resultFor,
	stopsDomain,
	type TaskOutcome,
	unfetchableSources,
	waitForRenderedOrder,
} from "@/lib/enrichment";
import {
	clearEnrichmentDiagnostic,
	readEnrichmentDiagnostic,
	rememberEnrichmentFailure,
} from "@/lib/enrichment-diagnostics";
import type { CaptureDraft } from "@/lib/envelope";
import { getSettings, isConfigured, type Settings } from "@/lib/settings";
import { type EnrichmentRunSummary, type EnrichmentState, getState, setState } from "@/lib/state";
import { STORE_LABELS } from "@/lib/stores";
import { errorMessage } from "@/lib/util";
import { nextEnrichmentTasks, reportEnrichmentResult } from "./api";
import { flushOutbox } from "./flusher";
import { addHistory, serialized } from "./history";
import { ingestCapture } from "./ingest";

const FETCH_TIMEOUT_MS = 30_000;
const TAB_LOAD_TIMEOUT_MS = 45_000;
const CLAIM_BATCH = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function updateEnrichmentState(patch: Partial<EnrichmentState>): Promise<void> {
	return serialized(async () => {
		const current = await getState("enrichment");
		await setState("enrichment", { ...current, ...patch });
	});
}

/** Refresh the server's pending count (popup display). */
export async function refreshEnrichmentCount(): Promise<{ pending: number }> {
	const settings = await getSettings();
	if (!isConfigured(settings)) return { pending: 0 };
	const { pending } = await nextEnrichmentTasks(settings, 0);
	await updateEnrichmentState({ pending, checkedAt: Date.now() });
	return { pending };
}

function draftFor(task: EnrichmentTask, pageUrl: string, html: string): CaptureDraft {
	return {
		source: task.source,
		kind: "html_snapshot",
		trigger: "backfill",
		pageType: "order_detail",
		pageUrl,
		pageTitle: htmlTitle(html),
		orderIdHints: [task.externalOrderId],
		payload: { type: "html", html },
	};
}

async function queueSnapshot(
	task: EnrichmentTask,
	pageUrl: string,
	html: string,
	via: "fetch" | "tab",
): Promise<TaskOutcome> {
	const outcome = await ingestCapture(draftFor(task, pageUrl, html));
	if (outcome.status === "queued") return { kind: "captured", captureId: outcome.captureId, via };
	if (outcome.status === "invalid") return { kind: "error", message: `invalid capture: ${outcome.error}` };
	return { kind: "error", message: `capture skipped (${outcome.reason})` };
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const listener = (id: number, info: { status?: string }) => {
			if (id === tabId && info.status === "complete") done();
		};
		const timer = setTimeout(() => {
			browser.tabs.onUpdated.removeListener(listener);
			reject(new Error("timed out loading page"));
		}, timeoutMs);
		const done = () => {
			clearTimeout(timer);
			browser.tabs.onUpdated.removeListener(listener);
			resolve();
		};
		browser.tabs.onUpdated.addListener(listener);
		browser.tabs
			.get(tabId)
			.then((tab) => {
				if (tab.status === "complete") done();
			})
			.catch(() => {});
	});
}

/**
 * Client-rendered stores: open the page in an inactive tab and let it render.
 * Require rendered order data and queue a concrete snapshot regardless of
 * passive capture settings; content scripts are not an upload acknowledgement.
 */
async function captureViaTab(task: EnrichmentTask, settings: Settings): Promise<TaskOutcome> {
	const tab = await browser.tabs.create({ url: task.url, active: false });
	const tabId = tab.id;
	if (tabId === undefined) return { kind: "error", message: "could not open a background tab" };
	try {
		await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS).catch(() => {});
		const { facts, verdict } = await waitForRenderedOrder(async () => {
			const loaded = await browser.tabs.get(tabId);
			const finalUrl = loaded.url ?? task.url;
			const [res] = await browser.scripting.executeScript({
				target: { tabId },
				func: () => document.documentElement.outerHTML,
			});
			return {
				status: 200,
				finalUrl,
				redirected: finalUrl !== task.url,
				contentType: "text/html",
				html: typeof res?.result === "string" ? res.result : "",
			};
		}, task.externalOrderId);
		if (verdict.kind !== "ok") {
			if (verdict.kind === "no_data" && facts)
				void rememberEnrichmentFailure(settings.recorderMode, task, facts, "tab").catch(() => {});
			return { kind: "verdict", verdict };
		}
		if (!facts) throw new Error("rendered capture unavailable");
		return queueSnapshot(task, facts.finalUrl, facts.html, "tab");
	} finally {
		await browser.tabs.remove(tabId).catch(() => {});
	}
}

async function fetchTask(task: EnrichmentTask, settings: Settings): Promise<TaskOutcome> {
	let res: Response;
	try {
		res = await fetch(task.url, {
			credentials: "include",
			redirect: "follow",
			cache: "no-store",
			headers: { Accept: "text/html,application/xhtml+xml" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		return { kind: "error", message: `fetch failed: ${errorMessage(err)}` };
	}
	const html = res.ok ? await res.text().catch(() => "") : "";
	const finalUrl = res.url || task.url;
	const verdict = classifyFetch(
		{
			status: res.status,
			finalUrl,
			redirected: res.redirected,
			contentType: res.headers.get("content-type") ?? "",
			html,
		},
		task.externalOrderId,
	);
	if (verdict.kind === "ok") return queueSnapshot(task, finalUrl, html, "fetch");
	if (verdict.kind === "no_data") {
		if (CLIENT_RENDERED_STORES.has(task.source) && settings.fetchDetailsInTabs) return captureViaTab(task, settings);
		void rememberEnrichmentFailure(
			settings.recorderMode,
			task,
			{
				status: res.status,
				finalUrl,
				redirected: res.redirected,
				contentType: res.headers.get("content-type") ?? "",
				html,
			},
			"fetch",
		).catch(() => {});
	}
	return { kind: "verdict", verdict };
}

async function logOutcome(task: EnrichmentTask, outcome: TaskOutcome): Promise<void> {
	if (outcome.kind === "captured") return; // the outbox logs the upload itself
	const result = resultFor(outcome);
	await addHistory({
		id: crypto.randomUUID(),
		at: Date.now(),
		type: "capture",
		kind: "html_snapshot",
		source: task.source,
		pageType: "order_detail",
		url: task.url.slice(0, 500),
		label: `${STORE_LABELS[task.source]} order ${task.externalOrderId} · background fetch`,
		status: result.status === "done" ? "sent" : result.status === "skipped" ? "skipped" : "error",
		message: result.error?.slice(0, 250),
	});
}

let running: Promise<EnrichmentRunSummary> | null = null;

/** Single-flight run. Alarm runs respect the Options toggle; manual runs always go. */
export function runEnrichment(trigger: "alarm" | "manual"): Promise<EnrichmentRunSummary> {
	running ??= runOnce(trigger).finally(() => {
		running = null;
	});
	return running;
}

async function runOnce(trigger: "alarm" | "manual"): Promise<EnrichmentRunSummary> {
	const summary: EnrichmentRunSummary = {
		at: Date.now(),
		fetched: 0,
		tabs: 0,
		skipped: 0,
		failed: 0,
		stoppedDomains: [],
	};
	const settings = await getSettings();
	if (settings.recorderMode) await readEnrichmentDiagnostic().catch(() => {});
	else await clearEnrichmentDiagnostic().catch(() => {});
	if (!isConfigured(settings)) return { ...summary, message: "not configured" };
	if (trigger === "alarm" && !settings.fetchMissingDetails) return { ...summary, message: "disabled in options" };
	if (await getState("authPaused")) return { ...summary, message: "API key rejected; fix it in options" };

	await updateEnrichmentState({ running: true });
	const throttle = new DomainThrottle();
	const stopped = new Set<string>();
	let processed = 0;
	let pending = 0;
	try {
		while (processed < MAX_FETCHES_PER_RUN) {
			const batch = await nextEnrichmentTasks(
				settings,
				Math.min(CLAIM_BATCH, MAX_FETCHES_PER_RUN - processed),
				unfetchableSources(settings),
			);
			pending = batch.pending;
			if (batch.tasks.length === 0) break;
			for (const task of batch.tasks) {
				processed++;
				let outcome: TaskOutcome;
				const check = checkTask(task);
				if (!check.ok) outcome = { kind: "invalid", reason: check.reason };
				else if (stopped.has(check.domain))
					outcome = { kind: "skipped_domain", reason: `store unavailable (earlier request to ${check.domain})` };
				else {
					await sleep(throttle.reserve(check.domain, Date.now()));
					try {
						outcome = await fetchTask(task, settings);
					} catch (err) {
						outcome = { kind: "error", message: errorMessage(err) };
					}
					if (outcome.kind === "verdict" && stopsDomain(outcome.verdict)) stopped.add(check.domain);
				}
				const result = resultFor(outcome);
				if (outcome.kind === "captured" && outcome.via === "fetch") summary.fetched++;
				else if (outcome.kind === "captured") summary.tabs++;
				else if (result.status === "skipped") summary.skipped++;
				else summary.failed++;
				await logOutcome(task, outcome).catch(() => {});
				// If reporting fails the server re-offers the task after its claim expires.
				await reportEnrichmentResult(settings, task.id, result).catch(() => {});
			}
		}
	} catch (err) {
		summary.message = errorMessage(err);
	} finally {
		summary.stoppedDomains = [...stopped];
		await updateEnrichmentState({ running: false, lastRun: summary, pending, checkedAt: Date.now() });
		if (summary.fetched + summary.tabs > 0) void flushOutbox();
	}
	return summary;
}
