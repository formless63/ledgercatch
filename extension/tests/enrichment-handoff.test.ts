import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Browser, browser } from "wxt/browser";
import { nextEnrichmentTasks, reportEnrichmentResult } from "@/background/api";
import { runEnrichment } from "@/background/enrichment";
import { ingestCapture } from "@/background/ingest";
import { buildEnrichmentDiagnostic, ENRICHMENT_DIAGNOSTIC_KEY } from "@/lib/enrichment-diagnostics";
import { parseSettings } from "@/lib/settings";

vi.mock("@/background/api", () => ({
	nextEnrichmentTasks: vi.fn(),
	reportEnrichmentResult: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/background/ingest", () => ({
	ingestCapture: vi.fn().mockResolvedValue({ status: "queued", captureId: "capture-test" }),
}));
vi.mock("@/background/flusher", () => ({ flushOutbox: vi.fn().mockResolvedValue(undefined) }));
const task = {
	id: "11111111-2222-4333-8444-555555555555",
	source: "aliexpress",
	externalOrderId: "8299000000000001",
	url: "https://www.aliexpress.com/p/order/detail.html?orderId=8299000000000001",
} as const;
const shell = "<html><body><div id='root'></div></body></html>";
const ready = `<html><body>Order ${task.externalOrderId} Total $12.34</body></html>`;
// Select the Promise overloads used by enrichment rather than the callback
// overloads Vitest otherwise infers from these browser APIs.
const promiseTabs = browser.tabs as {
	create(properties: Browser.tabs.CreateProperties): Promise<Browser.tabs.Tab>;
	get(tabId: number): Promise<Browser.tabs.Tab>;
};
const snapshotScripting = browser.scripting as {
	executeScript(injection: {
		target: Browser.scripting.InjectionTarget;
		func: () => string;
	}): Promise<Browser.scripting.InjectionResult<string>[]>;
};
beforeEach(async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.useFakeTimers();
	await browser.storage.local.clear();
	await browser.storage.local.set({
		settings: parseSettings({
			serverUrl: "https://ledger.example.test",
			apiKey: "test",
			passiveCapture: true,
			fetchDetailsInTabs: true,
		}),
	});
	vi.mocked(nextEnrichmentTasks)
		.mockResolvedValueOnce({ tasks: [task], pending: 1 })
		.mockResolvedValue({ tasks: [], pending: 0 });
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue(new Response(shell, { status: 200, headers: { "content-type": "text/html" } })),
	);
	const tab = {
		id: 99,
		status: "complete" as const,
		url: task.url,
		active: false,
		index: 0,
		pinned: false,
		highlighted: false,
		incognito: false,
		selected: false,
		windowId: 1,
		frozen: false,
		discarded: false,
		autoDiscardable: true,
		groupId: -1,
		lastAccessed: 0,
	};
	vi.spyOn(promiseTabs, "create").mockResolvedValue(tab);
	vi.spyOn(promiseTabs, "get").mockResolvedValue(tab);
	vi.spyOn(browser.tabs, "remove").mockResolvedValue();
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("rendered capture handoff", () => {
	it("a successful fallback preserves a previous actual failure diagnostic", async () => {
		const previous = buildEnrichmentDiagnostic(
			task,
			{
				status: 200,
				finalUrl: task.url,
				redirected: false,
				contentType: "text/html",
				html: "<body>Previous actual failure</body>",
			},
			"tab",
			Date.now(),
		);
		await browser.storage.local.set({
			settings: parseSettings({
				serverUrl: "https://ledger.example.test",
				apiKey: "test",
				fetchDetailsInTabs: true,
				recorderMode: true,
			}),
			[ENRICHMENT_DIAGNOSTIC_KEY]: previous,
		});
		vi.spyOn(snapshotScripting, "executeScript").mockResolvedValue([
			{ frameId: 0, documentId: "synthetic-document", result: ready },
		]);
		const run = runEnrichment("manual");
		await vi.runAllTimersAsync();
		expect((await run).tabs).toBe(1);
		expect((await browser.storage.local.get(ENRICHMENT_DIAGNOSTIC_KEY))[ENRICHMENT_DIAGNOSTIC_KEY]).toBe(previous);
	});
	it("queues an acknowledged snapshot even when passive capture is enabled", async () => {
		vi.spyOn(snapshotScripting, "executeScript")
			.mockResolvedValueOnce([{ frameId: 0, documentId: "synthetic-document", result: shell }])
			.mockResolvedValue([{ frameId: 0, documentId: "synthetic-document", result: ready }]);
		const run = runEnrichment("manual");
		await vi.runAllTimersAsync();
		expect((await run).tabs).toBe(1);
		expect(ingestCapture).toHaveBeenCalledWith(
			expect.objectContaining({ trigger: "backfill", payload: { type: "html", html: ready } }),
		);
		expect(reportEnrichmentResult).toHaveBeenCalledWith(expect.anything(), task.id, {
			status: "done",
			captureId: "capture-test",
		});
		expect(browser.tabs.remove).toHaveBeenCalledWith(99);
	});
	it("fails still-empty pages, stops remaining store tasks and never uploads diagnostics", async () => {
		const second = { ...task, id: "22222222-2222-4333-8444-555555555555" };
		vi.mocked(nextEnrichmentTasks)
			.mockReset()
			.mockResolvedValueOnce({ tasks: [task, second], pending: 2 })
			.mockResolvedValue({ tasks: [], pending: 0 });
		await browser.storage.local.set({
			settings: parseSettings({
				serverUrl: "https://ledger.example.test",
				apiKey: "test",
				passiveCapture: true,
				fetchDetailsInTabs: true,
				recorderMode: true,
			}),
		});
		vi.spyOn(snapshotScripting, "executeScript").mockResolvedValue([
			{ frameId: 0, documentId: "synthetic-document", result: shell },
		]);
		const run = runEnrichment("manual");
		await vi.runAllTimersAsync();
		const summary = await run;
		expect(summary).toMatchObject({ tabs: 0, failed: 1, skipped: 1, stoppedDomains: ["aliexpress.com"] });
		expect(ingestCapture).not.toHaveBeenCalled();
		expect(reportEnrichmentResult).toHaveBeenCalledWith(expect.anything(), task.id, {
			status: "failed",
			error: "no order data after rendering",
		});
		expect(browser.tabs.create).toHaveBeenCalledTimes(1);
		expect((await browser.storage.local.get(ENRICHMENT_DIAGNOSTIC_KEY))[ENRICHMENT_DIAGNOSTIC_KEY]).toBeTypeOf(
			"string",
		);
	});
	it("recorder storage failure cannot change failure or domain cutoff", async () => {
		await browser.storage.local.set({
			settings: parseSettings({
				serverUrl: "https://ledger.example.test",
				apiKey: "test",
				fetchDetailsInTabs: true,
				recorderMode: true,
			}),
		});
		const originalSet = browser.storage.local.set.bind(browser.storage.local);
		vi.spyOn(browser.storage.local, "set").mockImplementation((items) =>
			ENRICHMENT_DIAGNOSTIC_KEY in items ? Promise.reject(new Error("Test storage unavailable")) : originalSet(items),
		);
		vi.spyOn(snapshotScripting, "executeScript").mockResolvedValue([
			{ frameId: 0, documentId: "synthetic-document", result: shell },
		]);
		const run = runEnrichment("manual");
		await vi.runAllTimersAsync();
		expect(await run).toMatchObject({ tabs: 0, failed: 1, stoppedDomains: ["aliexpress.com"] });
		expect(ingestCapture).not.toHaveBeenCalled();
		expect(reportEnrichmentResult).toHaveBeenCalledWith(expect.anything(), task.id, {
			status: "failed",
			error: "no order data after rendering",
		});
	});
});
