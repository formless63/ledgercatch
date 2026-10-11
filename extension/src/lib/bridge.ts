/**
 * window.postMessage protocol between the MAIN-world interceptor and the
 * isolated-world content script.
 *
 * Handshake: the MAIN script posts `hello`; the isolated script answers (and
 * also proactively posts, in case it loaded second) a `config` carrying a
 * random per-page token. The MAIN script accepts the first config only and
 * stamps every later `json` message with that token; the isolated script drops
 * anything without the right token. This keeps unrelated page messages out —
 * it is namespacing, not a security boundary (the page shares the MAIN world).
 *
 * No zod here: this module is bundled into the MAIN-world script.
 */

export const BRIDGE_NS = "ledgercatch/bridge@1" as const;

export interface BridgeHello {
	ns: typeof BRIDGE_NS;
	type: "hello";
}

export interface BridgeConfig {
	ns: typeof BRIDGE_NS;
	type: "config";
	token: string;
	/** Passive capture enabled for this store. */
	enabled: boolean;
	/** Recorder mode: forward every JSON response, not just order APIs. */
	recorder: boolean;
}

export interface BridgeJson {
	ns: typeof BRIDGE_NS;
	type: "json";
	token: string;
	requestUrl: string;
	/** True when the URL matched the store's known order-API patterns. */
	matched: boolean;
	body: unknown;
}

export type BridgeMessage = BridgeHello | BridgeConfig | BridgeJson;

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function isBridgeHello(v: unknown): v is BridgeHello {
	return isObject(v) && v.ns === BRIDGE_NS && v.type === "hello";
}

export function isBridgeConfig(v: unknown): v is BridgeConfig {
	return (
		isObject(v) &&
		v.ns === BRIDGE_NS &&
		v.type === "config" &&
		typeof v.token === "string" &&
		v.token.length >= 16 &&
		typeof v.enabled === "boolean" &&
		typeof v.recorder === "boolean"
	);
}

export function isBridgeJson(v: unknown, token: string): v is BridgeJson {
	return (
		isObject(v) &&
		v.ns === BRIDGE_NS &&
		v.type === "json" &&
		v.token === token &&
		typeof v.requestUrl === "string" &&
		v.requestUrl.length < 8192 &&
		typeof v.matched === "boolean" &&
		"body" in v
	);
}

/** Max serialized JSON body the interceptor will forward. */
export const MAX_JSON_CHARS = 5 * 1024 * 1024;

/**
 * Parse a response body as JSON, tolerating JSONP wrappers
 * (`mtopjsonp12({...})`) and XSSI prefixes (`)]}'`, `for(;;);`).
 * Returns `undefined` when the text is not JSON.
 */
export function parseJsonLoose(text: string): unknown {
	let t = text.trim();
	if (!t) return undefined;
	t = t.replace(/^\)\]\}',?\s*/, "").replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, "");
	const first = t[0];
	if (first !== "{" && first !== "[") {
		const m = /^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/.exec(t);
		if (!m?.[1]) return undefined;
		t = m[1].trim();
		if (t[0] !== "{" && t[0] !== "[") return undefined;
	}
	const quoted = quoteUnsafeIntegers(t);
	if (quoted !== t) {
		try {
			return JSON.parse(quoted) as unknown;
		} catch {
			/* quoting hit a string literal; fall back to the plain parse */
		}
	}
	try {
		return JSON.parse(t) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Turn bare integer literals above Number.MAX_SAFE_INTEGER into JSON strings
 * so IDs like AliExpress `tradeOrderId` (often > 2^53) keep every digit.
 * Only touches literals in value position (after `:`, `[` or `,`). If the
 * rewrite lands inside a string literal the result is invalid JSON and the
 * caller falls back to a normal parse.
 */
export function quoteUnsafeIntegers(text: string): string {
	if (!/\d{16}/.test(text)) return text;
	return text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, (whole, prefix: string, digits: string) =>
		Number.isSafeInteger(Number(digits)) ? whole : `${prefix}"${digits}"`,
	);
}

export function looksLikeJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	return /\bjson\b|javascript/i.test(contentType);
}
