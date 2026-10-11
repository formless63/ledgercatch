/**
 * MAIN-world network interceptor (runs in the page's own JS context at
 * document_start on supported store domains).
 *
 * Patches fetch and XMLHttpRequest to *observe* JSON responses from the
 * store's order APIs (or every JSON response in recorder mode) and forwards
 * them to the isolated content script with window.postMessage.
 *
 * Hard rules: never break the page. Every hook is wrapped in try/catch, the
 * original fetch promise is returned untouched, bodies are read from clones
 * only, and nothing here throws into page code.
 */
import { defineContentScript } from "wxt/utils/define-content-script";
import {
	BRIDGE_NS,
	type BridgeConfig,
	type BridgeHello,
	type BridgeJson,
	MAX_JSON_CHARS,
	isBridgeConfig,
	looksLikeJsonContentType,
	parseJsonLoose,
} from "@/lib/bridge";
import { STORE_MATCHES, isIgnoredApiUrl, isOrderApiUrl, storeForUrl } from "@/lib/stores";

const INSTALLED = Symbol.for("ledgercatch.interceptor");
/** Before the isolated script answers, buffer at most this much. */
const PRECONFIG_MAX_ITEMS = 30;
const PRECONFIG_MAX_CHARS = 8 * 1024 * 1024;
const PRECONFIG_WINDOW_MS = 10_000;

export default defineContentScript({
	matches: STORE_MATCHES,
	world: "MAIN",
	runAt: "document_start",
	allFrames: false,
	noScriptStartedPostMessage: true,
	main() {
		try {
			install();
		} catch {
			/* never break the page */
		}
	},
});

interface Captured {
	requestUrl: string;
	matched: boolean;
	body: unknown;
	size: number;
}

function install(): void {
	const g = globalThis as typeof globalThis & { [INSTALLED]?: boolean };
	if (g[INSTALLED]) return;
	Object.defineProperty(g, INSTALLED, { value: true, enumerable: false });

	const store = storeForUrl(location.href);
	if (!store) return;

	const startedAt = Date.now();
	let config: Pick<BridgeConfig, "token" | "enabled" | "recorder"> | null = null;
	const buffer: Captured[] = [];
	let bufferChars = 0;
	const targetOrigin = location.origin && location.origin !== "null" ? location.origin : "*";

	const post = (msg: BridgeHello | BridgeJson) => {
		try {
			window.postMessage(msg, targetOrigin);
		} catch {
			/* body not cloneable, etc. */
		}
	};

	const send = (item: Captured) => {
		if (!config) return;
		if (!config.enabled) return;
		if (!item.matched && !config.recorder) return;
		post({ ns: BRIDGE_NS, type: "json", token: config.token, requestUrl: item.requestUrl, matched: item.matched, body: item.body });
	};

	const emit = (item: Captured) => {
		if (config) {
			send(item);
			return;
		}
		if (Date.now() - startedAt > PRECONFIG_WINDOW_MS) return;
		if (buffer.length >= PRECONFIG_MAX_ITEMS || bufferChars + item.size > PRECONFIG_MAX_CHARS) return;
		buffer.push(item);
		bufferChars += item.size;
	};

	/** Decide before reading anything whether a URL is worth a look. */
	const wants = (url: string): { matched: boolean } | null => {
		const matched = isOrderApiUrl(store, url);
		if (matched) return { matched };
		if (isIgnoredApiUrl(store, url)) return config?.enabled && config.recorder ? { matched } : null;
		// Stores with unknown endpoints: look at every JSON response and sniff it.
		if (store.jsonSniff) return { matched };
		if (config) return config.enabled && config.recorder ? { matched } : null;
		// No config yet: maybe recorder mode; buffer briefly.
		return Date.now() - startedAt <= PRECONFIG_WINDOW_MS ? { matched } : null;
	};

	/** URL match, or (for sniffing stores) a body that mentions order fields. */
	const isOrderPayload = (matched: boolean, text: string): boolean =>
		matched || Boolean(store.jsonSniff?.test(text.slice(0, 2_000_000)));

	window.addEventListener("message", (event: MessageEvent) => {
		try {
			if (event.source !== window) return;
			const data: unknown = event.data;
			if (!isBridgeConfig(data)) return;
			if (config && data.token !== config.token) return; // first config wins
			config = { token: data.token, enabled: data.enabled, recorder: data.recorder };
			const queued = buffer.splice(0);
			bufferChars = 0;
			for (const item of queued) send(item);
		} catch {
			/* ignore */
		}
	});
	post({ ns: BRIDGE_NS, type: "hello" });

	const absolute = (url: string): string | null => {
		try {
			return new URL(url, location.href).toString();
		} catch {
			return null;
		}
	};

	// ---- fetch -------------------------------------------------------------
	const originalFetch = window.fetch;
	if (typeof originalFetch === "function") {
		const inspectResponse = async (url: string, matched: boolean, response: Response) => {
			if (response.type === "opaque" || response.type === "opaqueredirect") return;
			if (response.status >= 400 || response.bodyUsed) return;
			const contentType = response.headers.get("content-type");
			if (contentType && /event-stream|octet-stream|image\/|video\/|audio\//i.test(contentType)) return;
			if (!matched && !looksLikeJsonContentType(contentType)) return;
			const length = Number(response.headers.get("content-length") ?? "0");
			if (length > MAX_JSON_CHARS) return;
			const text = await response.clone().text();
			if (text.length > MAX_JSON_CHARS) return;
			const body = parseJsonLoose(text);
			if (body === undefined) return;
			emit({ requestUrl: response.url || url, matched: isOrderPayload(matched, text), body, size: text.length });
		};

		const patchedFetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
			const promise = Reflect.apply(originalFetch, this, args) as Promise<Response>;
			try {
				const [input] = args;
				const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
				const url = absolute(raw);
				const want = url ? wants(url) : null;
				if (url && want) {
					promise.then(
						(response) => {
							inspectResponse(url, want.matched, response).catch(() => {});
						},
						() => {},
					);
				}
			} catch {
				/* never break fetch */
			}
			return promise;
		};
		try {
			Object.defineProperty(patchedFetch, "name", { value: "fetch" });
			Object.defineProperty(patchedFetch, "toString", {
				value: () => Function.prototype.toString.call(originalFetch),
			});
		} catch {
			/* cosmetic */
		}
		window.fetch = patchedFetch as typeof fetch;
	}

	// ---- XMLHttpRequest ----------------------------------------------------
	const proto = XMLHttpRequest.prototype;
	const originalOpen = proto.open;
	const originalSend = proto.send;
	const xhrUrls = new WeakMap<XMLHttpRequest, string>();
	const hooked = new WeakSet<XMLHttpRequest>();

	const inspectXhr = (xhr: XMLHttpRequest, openedUrl: string) => {
		try {
			const url = absolute(xhr.responseURL || openedUrl);
			if (!url) return;
			const want = wants(url);
			if (!want) return;
			if (xhr.status >= 400 || xhr.status === 0) return;
			const contentType = xhr.getResponseHeader("content-type");
			if (!want.matched && !looksLikeJsonContentType(contentType)) return;
			let body: unknown;
			let text: string;
			if (xhr.responseType === "" || xhr.responseType === "text") {
				text = xhr.responseText;
				if (text.length > MAX_JSON_CHARS) return;
				body = parseJsonLoose(text);
			} else if (xhr.responseType === "json") {
				body = xhr.response as unknown;
				text = JSON.stringify(body ?? null);
				if (text.length > MAX_JSON_CHARS) return;
			} else {
				return;
			}
			if (body === undefined || body === null) return;
			emit({ requestUrl: url, matched: isOrderPayload(want.matched, text), body, size: text.length });
		} catch {
			/* ignore */
		}
	};

	proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
		try {
			xhrUrls.set(this, String(args[1]));
		} catch {
			/* ignore */
		}
		return Reflect.apply(originalOpen, this, args) as void;
	} as typeof proto.open;

	proto.send = function (this: XMLHttpRequest, ...args: unknown[]) {
		try {
			if (!hooked.has(this)) {
				hooked.add(this);
				const xhr = this;
				this.addEventListener("load", () => {
					const url = xhrUrls.get(xhr);
					if (url) inspectXhr(xhr, url);
				});
			}
		} catch {
			/* ignore */
		}
		return Reflect.apply(originalSend, this, args) as void;
	} as typeof proto.send;
}
