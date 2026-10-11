/**
 * Opt-in auto-detector for storefront order pages on any site.
 *
 * Not in the manifest: the background registers it at runtime with
 * `scripting.registerContentScripts` only while "Auto-detect order
 * confirmations on other sites" is on and the all-sites permission is
 * granted (see background/detector.ts).
 *
 * Privacy: it reads the DOM locally (a few `querySelector` probes). Pages
 * that do not match a platform's thank-you / order-detail markup are never
 * captured, and it makes no network requests; a match is handed to the
 * service worker with `runtime.sendMessage`, which applies the opt-in,
 * exclusions and once-per-URL rule before queueing it.
 */
import { browser } from "wxt/browser";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { defineContentScript } from "wxt/utils/define-content-script";
import { captureHtml, serializeDocument } from "@/lib/html";
import { sendToBackground } from "@/lib/messaging";
import { detectOrderPage, detectorUrlKey, isExcludedUrl, mayBecomeOrderPage } from "@/lib/order-detector";
import { waitForDomSettle } from "@/lib/settle";

/** How long to keep watching an order-ish URL for late-rendered markup (SPAs). */
const WATCH_MS = 20_000;
const CHECK_DEBOUNCE_MS = 400;
const SETTLE_QUIET_MS = 1_500;
const SETTLE_MAX_MS = 8_000;
/** Snapshots are stripped of scripts/styles first; this bounds what is left (< MAX_HTML_BYTES). */
const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
/** `SETTINGS_KEY` in lib/settings.ts (not imported: that module pulls in zod). */
const SETTINGS_STORAGE_KEY = "settings";

/** Minimal settings read; the service worker re-validates everything. */
async function detectorSettings(): Promise<{ enabled: boolean; serverUrl: string }> {
	const got = await browser.storage.local.get(SETTINGS_STORAGE_KEY);
	const raw = (got[SETTINGS_STORAGE_KEY] ?? {}) as Record<string, unknown>;
	const serverUrl = typeof raw.serverUrl === "string" ? raw.serverUrl : "";
	const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
	const enabled = raw.autoDetectOrders === true && raw.passiveCapture !== false && serverUrl !== "" && apiKey !== "";
	return { enabled, serverUrl };
}

export default defineContentScript({
	registration: "runtime",
	runAt: "document_idle",
	allFrames: false,
	noScriptStartedPostMessage: true,
	async main(ctx) {
		if (window.top !== window) return;
		try {
			const settings = await detectorSettings();
			if (!settings.enabled || isExcludedUrl(location.href, settings.serverUrl)) return;
			run(ctx);
		} catch (err) {
			console.debug("[ledgercatch] detector stopped:", err);
		}
	},
});

function run(ctx: ContentScriptContext): void {
	const sent = new Set<string>();
	let observer: MutationObserver | null = null;
	let stopTimer: ReturnType<typeof setTimeout> | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	let busy = false;

	const stopWatching = () => {
		observer?.disconnect();
		observer = null;
		clearTimeout(stopTimer);
		clearTimeout(debounce);
	};

	const capture = async (url: string) => {
		busy = true;
		try {
			await waitForDomSettle({ quietMs: SETTLE_QUIET_MS, maxMs: SETTLE_MAX_MS });
			if (ctx.isInvalid || location.href !== url) return;
			const match = detectOrderPage(url, document);
			if (!match) return;
			sent.add(detectorUrlKey(url));
			const html = captureHtml(serializeDocument(document), MAX_SNAPSHOT_BYTES);
			await sendToBackground("capture/detected", {
				source: "generic",
				kind: "html_snapshot",
				trigger: "passive",
				pageType: match.pageType,
				pageUrl: url,
				pageTitle: document.title,
				orderIdHints: [],
				payload: { type: "html", html },
			});
		} catch (err) {
			console.debug("[ledgercatch] detector submit failed:", err);
		} finally {
			busy = false;
		}
	};

	const check = (): boolean => {
		const url = location.href;
		if (busy || sent.has(detectorUrlKey(url))) return true;
		if (!detectOrderPage(url, document)) return false;
		stopWatching();
		void capture(url);
		return true;
	};

	const watch = () => {
		stopWatching();
		if (check()) return;
		if (!mayBecomeOrderPage(location.href)) return;
		observer = new MutationObserver(() => {
			clearTimeout(debounce);
			debounce = setTimeout(check, CHECK_DEBOUNCE_MS);
		});
		observer.observe(document.documentElement, { childList: true, subtree: true });
		stopTimer = setTimeout(stopWatching, WATCH_MS);
	};

	watch();
	// WXT fires this on pushState/replaceState/popstate (SPA navigations).
	ctx.addEventListener(window, "wxt:locationchange", watch);
	ctx.onInvalidated(stopWatching);
}
