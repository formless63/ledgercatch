import { beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import {
	buildEnrichmentDiagnostic,
	clearEnrichmentDiagnostic,
	DIAGNOSTIC_MAX_BYTES,
	DIAGNOSTIC_TTL_MS,
	ENRICHMENT_DIAGNOSTIC_ALARM,
	ENRICHMENT_DIAGNOSTIC_KEY,
	readEnrichmentDiagnostic,
	rememberEnrichmentFailure,
} from "@/lib/enrichment-diagnostics";
import { byteLength } from "@/lib/util";

const task = {
	id: "11111111-2222-4333-8444-555555555555",
	source: "aliexpress",
	externalOrderId: "8299000000000001",
	url: "https://www.aliexpress.com/p/order/detail.html?orderId=8299000000000001",
} as const;
const facts = {
	status: 200,
	finalUrl: `${task.url}&session=SYNTHETIC#private`,
	redirected: false,
	contentType: "text/html",
	html: "<html><body>Example empty shell</body></html>",
};
beforeEach(async () => {
	vi.restoreAllMocks();
	await browser.storage.local.clear();
	await browser.storage.local.set({ settings: { recorderMode: true } });
});
describe("local debug evidence", () => {
	it("caps the entire escaped UTF-8 JSON record and marks truncation", () => {
		const encoded = buildEnrichmentDiagnostic(task, { ...facts, html: '"😀'.repeat(200000) }, "fetch", 1000);
		expect(byteLength(encoded)).toBeLessThanOrEqual(DIAGNOSTIC_MAX_BYTES);
		const diagnostic = JSON.parse(encoded);
		expect(diagnostic.truncated).toBe(true);
		expect(diagnostic.html).not.toContain("�");
		expect(diagnostic.originalHtmlBytes).toBeGreaterThan(byteLength(diagnostic.html));
		expect(diagnostic.finalUrl).toBe(task.url);
	});
	it("stores only the latest response, only when recorder mode is enabled", async () => {
		await rememberEnrichmentFailure(false, task, facts, "fetch", 1000);
		expect(await readEnrichmentDiagnostic(1000)).toBeNull();
		await rememberEnrichmentFailure(true, task, facts, "fetch", 1000);
		await rememberEnrichmentFailure(true, task, { ...facts, html: "<body>Latest empty shell</body>" }, "tab", 2000);
		expect(await readEnrichmentDiagnostic(2000)).toMatchObject({
			via: "tab",
			html: "<body>Latest empty shell</body>",
			expiresAt: 2000 + DIAGNOSTIC_TTL_MS,
		});
		const stored = await browser.storage.local.get();
		expect(Object.keys(stored).filter((key) => key !== "settings")).toEqual([ENRICHMENT_DIAGNOSTIC_KEY]);
	});
	it("expires and clears evidence and its alarm", async () => {
		const clear = vi.spyOn(browser.alarms, "clear");
		await rememberEnrichmentFailure(true, task, facts, "fetch", 1000);
		expect(await readEnrichmentDiagnostic(1000 + DIAGNOSTIC_TTL_MS)).toBeNull();
		expect((await browser.storage.local.get(ENRICHMENT_DIAGNOSTIC_KEY))[ENRICHMENT_DIAGNOSTIC_KEY]).toBeUndefined();
		expect(clear).toHaveBeenCalledWith(ENRICHMENT_DIAGNOSTIC_ALARM);
		await rememberEnrichmentFailure(true, task, facts, "fetch", 1000);
		await clearEnrichmentDiagnostic();
		expect(await readEnrichmentDiagnostic(1000)).toBeNull();
	});
	it("drops oversized or invalid stored records before decoding", async () => {
		await browser.storage.local.set({ [ENRICHMENT_DIAGNOSTIC_KEY]: "x".repeat(DIAGNOSTIC_MAX_BYTES + 1) });
		expect(await readEnrichmentDiagnostic(1000)).toBeNull();
		await browser.storage.local.set({ [ENRICHMENT_DIAGNOSTIC_KEY]: "not-json" });
		expect(await readEnrichmentDiagnostic(1000)).toBeNull();
	});
	it("does not retain stale opt-in evidence after recorder mode is disabled", async () => {
		await browser.storage.local.set({ settings: { recorderMode: false } });
		await rememberEnrichmentFailure(true, task, facts, "tab", 1000);
		expect(await readEnrichmentDiagnostic(1000)).toBeNull();
	});
});
