import { describe, expect, it } from "vitest";
import { aiDisclosure, isLocalHost } from "./ai-disclosure.server";
import { clip, failureRate, isFailing, machineName } from "./health";
import { isAutoReparseParser, planReparse, reparseBudget } from "./reparse";
import {
	compactedPointer,
	decodeCompactedBody,
	encodeCompactedBody,
	retentionDefaults,
} from "./retention";

describe("capture compaction envelope", () => {
	it("round-trips text and json bodies through gzip", () => {
		const body = {
			bodyText: `<html>${"x".repeat(300_000)}</html>`,
			bodyJson: { html: "<p>hi</p>", n: [1, 2] },
		};
		const { gzip, bytes } = encodeCompactedBody(body);
		expect(gzip.byteLength).toBeLessThan(bytes / 10);
		expect(decodeCompactedBody(gzip)).toEqual(body);
		expect(
			decodeCompactedBody(
				encodeCompactedBody({ bodyText: null, bodyJson: null }).gzip,
			),
		).toEqual({ bodyText: null, bodyJson: null });
	});

	it("recognizes only the exact pointer shape", () => {
		const pointer = {
			storageKey: "captures/u/k",
			bytes: 10,
			storedBytes: 2,
			sha256: "a",
			compactedAt: "x",
			v: 1,
		};
		expect(compactedPointer({ compacted: pointer })).toEqual(pointer);
		expect(compactedPointer({ compacted: pointer, html: "x" })).toBeNull();
		expect(compactedPointer({ html: "x" })).toBeNull();
		expect(compactedPointer([{ compacted: pointer }])).toBeNull();
		expect(compactedPointer(null)).toBeNull();
		expect(compactedPointer({ compacted: { bytes: 1 } })).toBeNull();
	});

	it("reads env defaults with bounds", () => {
		expect(retentionDefaults({})).toEqual({
			enabled: true,
			keepRawDays: 365,
			compactMinBytes: 262_144,
			batch: 10,
		});
		expect(
			retentionDefaults({
				CAPTURE_COMPACTION: "OFF",
				CAPTURE_RETENTION_DAYS: "30",
				CAPTURE_COMPACT_MIN_BYTES: "12",
				CAPTURE_COMPACT_BATCH: "abc",
			}),
		).toEqual({
			enabled: false,
			keepRawDays: 30,
			compactMinBytes: 1024,
			batch: 10,
		});
	});
});

describe("auto-reparse planning", () => {
	const parser = { source: "amazon", version: 3 };
	const base = {
		parserId: "amazon",
		cursorReceivedAt: null,
		cursorId: null,
		completedAt: null,
	};
	it("resets on first sight and on any version change", () => {
		expect(planReparse(parser, undefined)).toEqual({ action: "reset" });
		expect(
			planReparse(parser, {
				...base,
				targetVersion: 2,
				completedAt: new Date(),
			}),
		).toEqual({ action: "reset" });
	});
	it("skips completed versions so it never loops", () => {
		expect(
			planReparse(parser, {
				...base,
				targetVersion: 3,
				completedAt: new Date(),
			}),
		).toEqual({ action: "skip" });
		expect(planReparse({ source: "x", version: 0 }, undefined)).toEqual({
			action: "skip",
		});
	});
	it("continues from the stored cursor", () => {
		const at = new Date("2026-01-01T00:00:00.123Z");
		expect(
			planReparse(parser, {
				...base,
				targetVersion: 3,
				cursorReceivedAt: at,
				cursorId: "id",
			}),
		).toEqual({
			action: "continue",
			cursor: { receivedAt: at, id: "id" },
		});
	});
	it("never auto-reparses AI or structured outputs", () => {
		expect(isAutoReparseParser("ai")).toBe(false);
		expect(isAutoReparseParser("agent")).toBe(false);
		expect(isAutoReparseParser("generic")).toBe(true);
		expect(reparseBudget({})).toBe(200);
		expect(reparseBudget({ AUTO_REPARSE_BATCH: "5000" })).toBe(1000);
	});
});

describe("health helpers", () => {
	it("flags failing parser versions with enough samples", () => {
		const row = {
			parserId: "ebay",
			parserVersion: 2,
			total: 10,
			failed: 2,
			noOrders: 5,
			needsReview: 0,
		};
		expect(failureRate(row)).toBe(0.2);
		expect(isFailing(row)).toBe(true);
		expect(isFailing({ ...row, total: 4, failed: 4 })).toBe(false);
	});
	it("produces machine names and clips identifiers", () => {
		expect(machineName("needs_review")).toBe("needs-review");
		expect(machineName("captures.process")).toBe("captures-process");
		expect(machineName("9lives")).toBeNull();
		expect(clip("<b>x</b>")).toBe("bx/b");
		expect(clip("a".repeat(100)).length).toBe(64);
	});
});

describe("AI disclosure", () => {
	it("exposes the host only", () => {
		const info = aiDisclosure({
			AI_MODEL: "m",
			AI_BASE_URL: "https://llm.example.com:8443/v1",
			AI_API_KEY: "secret",
		});
		expect(info).toEqual({
			configured: true,
			host: "llm.example.com:8443",
			usesDefaultEndpoint: false,
			local: false,
		});
		expect(JSON.stringify(info)).not.toContain("secret");
		expect(aiDisclosure({})).toMatchObject({
			configured: false,
			host: "api.openai.com",
			usesDefaultEndpoint: true,
		});
		expect(
			aiDisclosure({ AI_MODEL: "m", AI_BASE_URL: "not a url" }).host,
		).toBeNull();
	});
	it("recognizes local endpoints", () => {
		for (const h of [
			"localhost",
			"127.0.0.1",
			"ollama",
			"192.168.1.5",
			"10.0.0.2",
			"172.20.0.4",
			"gpu.lan",
			"[::1]",
		])
			expect(isLocalHost(h), h).toBe(true);
		for (const h of ["api.openai.com", "172.32.0.1", "8.8.8.8"])
			expect(isLocalHost(h), h).toBe(false);
	});
});
