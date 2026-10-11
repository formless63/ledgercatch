import { describe, expect, it } from "vitest";
import { BRIDGE_NS, isBridgeConfig, isBridgeJson, parseJsonLoose, quoteUnsafeIntegers } from "@/lib/bridge";
import { isRecentDuplicate, pruneHashes, rememberHash } from "@/lib/dedupe";
import { shrinkHtml } from "@/lib/html";
import { normalizeServerUrl, originPattern, sanitizeUrl, sha256Hex, truncateToBytes } from "@/lib/util";

describe("parseJsonLoose", () => {
	it("parses plain JSON, JSONP and XSSI-prefixed bodies", () => {
		expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
		expect(parseJsonLoose(' mtopjsonp12({"ret":["SUCCESS::ok"]}) ')).toEqual({ ret: ["SUCCESS::ok"] });
		expect(parseJsonLoose(")]}',\n[1,2]")).toEqual([1, 2]);
		expect(parseJsonLoose("for(;;);{\"x\":true}")).toEqual({ x: true });
		expect(parseJsonLoose("<html>")).toBeUndefined();
		expect(parseJsonLoose("")).toBeUndefined();
	});
	it("keeps integers above 2^53 as exact strings", () => {
		const body = parseJsonLoose('{"tradeOrderId":8123456789012345678,"small":1234567890123456,"list":[9007199254740993]}');
		expect(body).toEqual({ tradeOrderId: "8123456789012345678", small: 1234567890123456, list: ["9007199254740993"] });
	});
	it("does not corrupt numbers inside strings", () => {
		const text = '{"s":"a:9007199254740993,b"}';
		expect(quoteUnsafeIntegers(text)).not.toBe(text); // naive rewrite happens...
		expect(parseJsonLoose(text)).toEqual({ s: "a:9007199254740993,b" }); // ...but parse falls back
	});
});

describe("bridge guards", () => {
	const token = "0123456789abcdef0123456789abcdef";
	it("validates config and json messages", () => {
		expect(isBridgeConfig({ ns: BRIDGE_NS, type: "config", token, enabled: true, recorder: false })).toBe(true);
		expect(isBridgeConfig({ ns: BRIDGE_NS, type: "config", token: "short", enabled: true, recorder: false })).toBe(false);
		const json = { ns: BRIDGE_NS, type: "json", token, requestUrl: "https://x", matched: true, body: {} };
		expect(isBridgeJson(json, token)).toBe(true);
		expect(isBridgeJson({ ...json, token: "other" }, token)).toBe(false);
		expect(isBridgeJson({ ...json, ns: "someone-else" }, token)).toBe(false);
	});
});

describe("dedupe cache", () => {
	it("expires after 24h and caps size", () => {
		const day = 24 * 60 * 60 * 1000;
		let map = rememberHash({}, "h1", 0);
		expect(isRecentDuplicate(map, "h1", day - 1)).toBe(true);
		expect(isRecentDuplicate(map, "h1", day)).toBe(false);
		map = rememberHash(map, "h2", day + 1);
		expect(Object.keys(map)).toEqual(["h2"]);
		const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
		expect(Object.keys(pruneHashes(big, 10, day, 3))).toEqual(["k9", "k8", "k7"]);
	});
});

describe("shrinkHtml", () => {
	it("drops styles/svg, then scripts (keeping JSON data), then truncates", () => {
		const html = `<html><style>${"x".repeat(500)}</style><script>${"y".repeat(500)}</script><script type="application/json">{"order":1}</script><body>ok</body></html>`;
		const out = shrinkHtml(html, 300);
		expect(out).toContain('{"order":1}');
		expect(out).toContain("<body>ok</body>");
		expect(out).not.toContain("xxxx");
		expect(out).not.toContain("yyyy");
		expect(shrinkHtml("z".repeat(1000), 100)).toHaveLength(100);
		expect(shrinkHtml("small", 100)).toBe("small");
	});
});

describe("util", () => {
	it("normalizes server URLs", () => {
		expect(normalizeServerUrl(" https://orders.example.com/ ")).toBe("https://orders.example.com");
		expect(normalizeServerUrl("http://127.0.0.1:3000/base/?x=1")).toBe("http://127.0.0.1:3000/base");
		expect(normalizeServerUrl("ftp://x")).toBeNull();
		expect(normalizeServerUrl("nope")).toBeNull();
		expect(originPattern("https://orders.example.com/base")).toBe("https://orders.example.com/*");
	});
	it("sanitizes URLs and truncates by bytes", () => {
		expect(sanitizeUrl("https://u:p@x.com/a#h")).toBe("https://x.com/a");
		expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
		expect(truncateToBytes("ééé", 5)).toBe("éé");
	});
	it("hashes with sha256", async () => {
		expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});
});
