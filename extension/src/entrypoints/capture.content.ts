/**
 * Isolated-world collector on supported store domains.
 *
 * - Bridges JSON captured by the MAIN-world interceptor to the background.
 * - Takes an HTML snapshot of order pages once the DOM settles, and again on
 *   SPA navigations.
 * - Recorder mode: forwards every JSON response and snapshots every page.
 */
import type { CaptureKind, CapturePayload, PageType } from "@app/shared/capture";
import { MAX_HTML_BYTES } from "@app/shared/capture";
import { browser } from "wxt/browser";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import { defineContentScript } from "wxt/utils/define-content-script";
import { BRIDGE_NS, type BridgeConfig, isBridgeHello, isBridgeJson, MAX_JSON_CHARS } from "@/lib/bridge";
import { serializeDocument, shrinkHtml } from "@/lib/html";
import { sendToBackground } from "@/lib/messaging";
import { mouserPdfInvoiceNumber } from "@/lib/mouser-invoices";
import { getSettings, parseSettings, SETTINGS_KEY, type Settings } from "@/lib/settings";
import { domReady, waitForDomSettle } from "@/lib/settle";
import {
	classifyUrl,
	collectOrderIdDomText,
	extractOrderIdHints,
	STORE_MATCHES,
	type StoreDefinition,
	storeForUrl,
} from "@/lib/stores";
import { delay } from "@/lib/util";

const SETTLE_QUIET_MS = 2_000;
const SETTLE_MAX_MS = 15_000;
const MAX_LINKS_FOR_HINTS = 3_000;
const MAX_TEXT_FOR_HINTS = 2_000_000;
/** Extra wait for stores that render order data late (Amazon CSD decryption). */
const NOT_READY_MAX_MS = 15_000;

export default defineContentScript({
	matches: STORE_MATCHES,
	runAt: "document_start",
	allFrames: false,
	noScriptStartedPostMessage: true,
	async main(ctx) {
		const store = storeForUrl(location.href);
		if (!store) return;
		try {
			await run(ctx, store);
		} catch (err) {
			console.debug("[ledgercatch] content script stopped:", err);
		}
	},
});

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function run(ctx: ContentScriptContext, store: StoreDefinition): Promise<void> {
	const token = randomToken();
	let settings: Settings = await getSettings();
	const enabled = () => settings.passiveCapture && settings.stores[store.id];
	const recorder = () => enabled() && settings.recorderMode;

	const postConfig = () => {
		const msg: BridgeConfig = { ns: BRIDGE_NS, type: "config", token, enabled: enabled(), recorder: recorder() };
		window.postMessage(msg, location.origin && location.origin !== "null" ? location.origin : "*");
	};

	const submit = async (kind: CaptureKind, pageType: PageType, payload: CapturePayload, hints: string[]) => {
		if (ctx.isInvalid) return;
		try {
			await sendToBackground("capture/submit", {
				source: store.id,
				kind,
				trigger: "passive",
				pageType,
				pageUrl: location.href,
				pageTitle: document.title,
				orderIdHints: hints,
				payload,
			});
		} catch (err) {
			// Extension reloaded / SW asleep and failed to wake: nothing useful to do here.
			console.debug("[ledgercatch] submit failed:", err);
		}
	};

	// ---- bridge from MAIN world ------------------------------------------------
	ctx.addEventListener(window, "message", (event: MessageEvent) => {
		if (event.source !== window) return;
		const data: unknown = event.data;
		if (isBridgeHello(data)) {
			postConfig();
			return;
		}
		if (!isBridgeJson(data, token)) return;
		if (!enabled() || (!data.matched && !recorder())) return;
		let json: string;
		try {
			json = JSON.stringify(data.body);
		} catch {
			return;
		}
		if (json === undefined || json.length > MAX_JSON_CHARS) return;
		const { pageType } = classifyUrl(location.href);
		const hints = extractOrderIdHints(store, {
			urls: [location.href, data.requestUrl],
			json: json.slice(0, MAX_TEXT_FOR_HINTS),
		});
		void submit("api_json", pageType, { type: "json", requestUrl: data.requestUrl, body: data.body }, hints);
	});
	postConfig();

	browser.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !changes[SETTINGS_KEY]) return;
		settings = parseSettings(changes[SETTINGS_KEY].newValue);
		postConfig();
	});

	// ---- HTML snapshots ------------------------------------------------------
	let controller: AbortController | null = null;
	let lastSnapshotUrl = "";

	const snapshot = async () => {
		controller?.abort();
		const ac = new AbortController();
		controller = ac;
		const url = location.href;
		if (mouserPdfInvoiceNumber(url)) return; // The background saves PDF bytes, never the viewer shell.
		const { pageType } = classifyUrl(url);
		if (!enabled() || (pageType === "unknown" && !recorder())) return;
		try {
			await domReady();
			await waitForDomSettle({ quietMs: SETTLE_QUIET_MS, maxMs: SETTLE_MAX_MS, signal: ac.signal });
			if (store.notReadySelector) {
				const until = Date.now() + NOT_READY_MAX_MS;
				while (document.querySelector(store.notReadySelector) && Date.now() < until && !ac.signal.aborted) {
					await delay(500);
				}
				if (ac.signal.aborted) return;
			}
		} catch {
			return; // superseded by a newer navigation
		}
		if (ctx.isInvalid || location.href !== url || url === lastSnapshotUrl) return;
		lastSnapshotUrl = url;
		const html = shrinkHtml(serializeDocument(document), MAX_HTML_BYTES);
		const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
			.slice(0, MAX_LINKS_FOR_HINTS)
			.map((a) => a.href);
		const text = (document.body?.innerText ?? "").slice(0, MAX_TEXT_FOR_HINTS);
		const domText = collectOrderIdDomText(store, document);
		const hints = extractOrderIdHints(store, { urls: [url, ...links], text, domText });
		await submit("html_snapshot", pageType, { type: "html", html }, hints);
	};

	void snapshot();
	// WXT polls location.href and fires this on pushState/replaceState/hash changes.
	ctx.addEventListener(window, "wxt:locationchange", () => {
		void snapshot();
	});
	ctx.onInvalidated(() => controller?.abort());
}
