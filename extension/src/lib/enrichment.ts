/**
 * Pure helpers for background enrichment ("fetch missing order details"):
 * task URL validation, per-store-domain throttling, classification of a
 * fetched page, and mapping outcomes to server results. Unit-tested in Node.
 */
import type { EnrichmentResultRequest, EnrichmentTask } from "@app/shared/capture";
import { type StoreDefinition, storeForUrl } from "./stores";

export const ENRICH_ALARM = "enrichment-fetch";
export const ENRICH_PERIOD_MINUTES = 15;
/** Hard cap on pages fetched per run. */
export const MAX_FETCHES_PER_RUN = 20;
/** Minimum spacing between requests to the same store domain. */
export const MIN_DOMAIN_INTERVAL_MS = 3000;
/** How long a background tab may render before it is closed. */
export const TAB_RENDER_MS = 20_000;
export const TAB_READINESS_POLL_MS = 500;

/** Stores whose order-detail pages render client-side (fetched HTML is a shell). */
export const CLIENT_RENDERED_STORES = new Set(["aliexpress", "digikey", "alibaba"]);

/**
 * Stores whose tasks the extension cannot complete with these settings: a
 * plain fetch of a client-rendered page never shows the order, so without
 * background tabs those tasks are left pending on the server.
 */
export function unfetchableSources(settings: { fetchDetailsInTabs: boolean }): string[] {
	return settings.fetchDetailsInTabs ? [] : [...CLIENT_RENDERED_STORES];
}

/** The registrable store domain a URL belongs to (throttle key), or null. */
export function storeDomain(url: string): string | null {
	const store = storeForUrl(url);
	if (!store) return null;
	const host = new URL(url).hostname.toLowerCase();
	return store.domains.find((d) => host === d || host.endsWith(`.${d}`)) ?? null;
}

export type TaskCheck = { ok: true; store: StoreDefinition; domain: string } | { ok: false; reason: string };

/**
 * Only fetch https URLs on the task's own store domains: the server must never
 * be able to make the extension send store cookies anywhere else.
 */
export function checkTask(task: Pick<EnrichmentTask, "source" | "url">): TaskCheck {
	let parsed: URL;
	try {
		parsed = new URL(task.url);
	} catch {
		return { ok: false, reason: "invalid URL" };
	}
	if (parsed.protocol !== "https:") return { ok: false, reason: "URL is not https" };
	if (parsed.username || parsed.password) return { ok: false, reason: "URL has credentials" };
	const store = storeForUrl(task.url);
	if (!store || store.id !== task.source) return { ok: false, reason: "URL is not on the store's domain" };
	const domain = storeDomain(task.url);
	if (!domain) return { ok: false, reason: "URL is not on the store's domain" };
	return { ok: true, store, domain };
}

/**
 * Per-domain spacing. `reserve` returns how long to wait before the request
 * and books the slot, so concurrent callers queue up correctly.
 */
export class DomainThrottle {
	private readonly next = new Map<string, number>();
	constructor(private readonly intervalMs = MIN_DOMAIN_INTERVAL_MS) {}

	reserve(domain: string, now: number): number {
		const at = Math.max(now, this.next.get(domain) ?? 0);
		this.next.set(domain, at + this.intervalMs);
		return at - now;
	}
}

const LOGIN_URL =
	/\/(ap\/signin|ap\/mfa|signin|sign-in|login|log-in)\b|OrderHistoryLogin|signin\.ebay\.|login\.aliexpress\.|passport\.|\/MyDigiKey\/Login|identity\.digikey|auth\.digikey/i;
const RATE_LIMIT_URL = /limitexceeded|captcha|validateCaptcha|\/errors\/validateCaptcha|\/splashui\//i;
/** Bot-challenge interstitials served with HTTP 200 (eBay "Pardon Our Interruption"). */
const CHALLENGE_PAGE = /<title[^>]*>\s*(?:Pardon Our Interruption|Security Measure|Robot Check)/i;

export type FetchFacts = {
	status: number;
	/** Final URL after redirects (`Response.url`). */
	finalUrl: string;
	redirected: boolean;
	contentType: string;
	html: string;
};

export type FetchVerdict =
	| { kind: "ok" }
	| { kind: "signed_out"; detail: string }
	| { kind: "blocked"; detail: string }
	| { kind: "http_error"; detail: string }
	| { kind: "no_data"; detail: string; stage?: "rendered" };

/** Visible-ish text: scripts, styles and tags removed (no DOMParser in the worker). */
export function visibleText(html: string): string {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/\s+/g, " ");
}

const MONEY =
	/(?:[$€£¥]|US\s?\$|C\$|A\$|\b(?:USD|EUR|GBP|CAD|AUD)\b)\s?\d|\d[\d.,]*\s?(?:€|\b(?:USD|EUR|GBP|CAD|AUD)\b)/;

/** Does the server-rendered page show the order (its id and at least one amount)? */
export function hasOrderData(html: string, externalOrderId: string): boolean {
	const text = visibleText(html);
	return text.includes(externalOrderId) && MONEY.test(text);
}

const PASSWORD_FORM = /<input[^>]+type\s*=\s*["']?password/i;

export function classifyFetch(facts: FetchFacts, externalOrderId: string): FetchVerdict {
	const { status, finalUrl } = facts;
	if (RATE_LIMIT_URL.test(finalUrl) || status === 429)
		return { kind: "blocked", detail: `rate limited (HTTP ${status})` };
	if (status === 401 || status === 403) return { kind: "signed_out", detail: `HTTP ${status}` };
	if ((facts.redirected || status < 400) && LOGIN_URL.test(finalUrl))
		return { kind: "signed_out", detail: "redirected to sign-in" };
	if (status >= 400 && status < 500) return { kind: "signed_out", detail: `HTTP ${status}` };
	if (status >= 500 || status === 0) return { kind: "http_error", detail: `HTTP ${status}` };
	if (CHALLENGE_PAGE.test(facts.html.slice(0, 20_000))) return { kind: "blocked", detail: "bot challenge page" };
	if (!/html/i.test(facts.contentType))
		return { kind: "no_data", detail: `unexpected ${facts.contentType || "content"}` };
	if (PASSWORD_FORM.test(facts.html) && !facts.html.includes(externalOrderId))
		return { kind: "signed_out", detail: "sign-in form" };
	if (!hasOrderData(facts.html, externalOrderId)) return { kind: "no_data", detail: "no order data in fetched page" };
	return { kind: "ok" };
}

/** Stop fetching further pages from this store domain in the current run. */
export function stopsDomain(verdict: FetchVerdict): boolean {
	return (
		verdict.kind === "signed_out" ||
		verdict.kind === "blocked" ||
		(verdict.kind === "no_data" && verdict.stage === "rendered")
	);
}

/** One bounded render window, never another navigation or HTTP retry. */
export async function waitForRenderedOrder(
	read: () => Promise<FetchFacts>,
	externalOrderId: string,
	clock: { now: () => number; wait: (ms: number) => Promise<void> } = {
		now: Date.now,
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	},
): Promise<{ facts: FetchFacts | null; verdict: FetchVerdict }> {
	const deadline = clock.now() + TAB_RENDER_MS;
	const maxReads = Math.ceil(TAB_RENDER_MS / TAB_READINESS_POLL_MS) + 1;
	let latest: FetchFacts | null = null;
	for (let reads = 1; ; reads++) {
		const timeout = Symbol("read timeout");
		let timer: ReturnType<typeof setTimeout> | undefined;
		const facts = await new Promise<FetchFacts | typeof timeout>((resolve, reject) => {
			timer = setTimeout(() => resolve(timeout), Math.max(0, deadline - clock.now()));
			void read().then(resolve, reject);
		}).finally(() => clearTimeout(timer));
		if (facts === timeout)
			return {
				facts: latest,
				verdict: { kind: "no_data", detail: "timed out reading rendered page", stage: "rendered" },
			};
		latest = facts;
		const verdict = classifyFetch(facts, externalOrderId);
		if (verdict.kind !== "no_data") return { facts, verdict };
		const remaining = deadline - clock.now();
		if (remaining <= 0 || reads >= maxReads)
			return { facts, verdict: { kind: "no_data", detail: "no order data after rendering", stage: "rendered" } };
		await clock.wait(Math.min(TAB_READINESS_POLL_MS, remaining));
	}
}

export type TaskOutcome =
	| { kind: "captured"; captureId: string; via: "fetch" | "tab" }
	| { kind: "verdict"; verdict: Exclude<FetchVerdict, { kind: "ok" }> }
	| { kind: "invalid"; reason: string }
	| { kind: "skipped_domain"; reason: string }
	| { kind: "error"; message: string };

/** What to report to POST /api/v1/enrichment/{id}/result. */
export function resultFor(outcome: TaskOutcome): EnrichmentResultRequest {
	switch (outcome.kind) {
		case "captured":
			return { status: "done", captureId: outcome.captureId };
		case "verdict":
			switch (outcome.verdict.kind) {
				case "signed_out":
					return { status: "skipped", error: `signed out (${outcome.verdict.detail})` };
				case "blocked":
					return { status: "skipped", error: outcome.verdict.detail };
				default:
					return { status: "failed", error: outcome.verdict.detail };
			}
		case "invalid":
			return { status: "failed", error: outcome.reason };
		case "skipped_domain":
			return { status: "skipped", error: outcome.reason };
		case "error":
			return { status: "failed", error: outcome.message.slice(0, 2000) };
	}
}

/** `<title>` of an HTML document, for the capture's pageTitle. */
export function htmlTitle(html: string): string {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 200_000));
	return m?.[1]?.replace(/\s+/g, " ").trim().slice(0, 1000) ?? "";
}
