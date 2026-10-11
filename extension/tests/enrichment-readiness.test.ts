import { afterEach, describe, expect, it, vi } from "vitest";
import { type FetchFacts, stopsDomain, TAB_RENDER_MS, waitForRenderedOrder } from "@/lib/enrichment";

const id = "8299000000000001";
const url = `https://www.aliexpress.com/p/order/detail.html?orderId=${id}`;
const shell = "<html><body><div id='root'></div></body></html>";
const ready = `<html><body>Order ${id} Total $12.34</body></html>`;
const facts = (html: string, finalUrl = url): FetchFacts => ({
	status: 200,
	finalUrl,
	redirected: finalUrl !== url,
	contentType: "text/html",
	html,
});
afterEach(() => vi.useRealTimers());
describe("bounded rendered readiness", () => {
	it("waits for visible data then exits within the existing render window", async () => {
		let now = 0;
		const read = vi.fn().mockResolvedValueOnce(facts(shell)).mockResolvedValue(facts(ready));
		const result = await waitForRenderedOrder(read, id, {
			now: () => now,
			wait: async (ms) => {
				now += ms;
			},
		});
		expect(result.verdict).toEqual({ kind: "ok" });
		expect(read).toHaveBeenCalledTimes(2);
		expect(now).toBe(500);
	});
	it("a still-empty page times out and stops this store for the run", async () => {
		let now = 0;
		const read = vi.fn().mockResolvedValue(facts(shell));
		const result = await waitForRenderedOrder(read, id, {
			now: () => now,
			wait: async (ms) => {
				now += ms;
			},
		});
		expect(result.verdict).toMatchObject({ kind: "no_data", stage: "rendered" });
		expect(stopsDomain(result.verdict)).toBe(true);
		expect(now).toBe(TAB_RENDER_MS);
		expect(read).toHaveBeenCalledTimes(41);
	});
	it("also bounds a stalled injected read call", async () => {
		vi.useFakeTimers();
		const pending = waitForRenderedOrder(() => new Promise(() => {}), id);
		await vi.advanceTimersByTimeAsync(TAB_RENDER_MS);
		const result = await pending;
		expect(result.facts).toBeNull();
		expect(result.verdict).toMatchObject({
			kind: "no_data",
			stage: "rendered",
			detail: "timed out reading rendered page",
		});
		expect(stopsDomain(result.verdict)).toBe(true);
	});
	it("exits immediately for sign-in and challenge pages", async () => {
		for (const [page, finalUrl, kind] of [
			[shell, "https://login.aliexpress.com/login", "signed_out"],
			["<title>Robot Check</title>", url, "blocked"],
		] as const) {
			const read = vi.fn().mockResolvedValue(facts(page, finalUrl));
			const wait = vi.fn();
			const result = await waitForRenderedOrder(read, id, { now: () => 0, wait });
			expect(result.verdict.kind).toBe(kind);
			expect(read).toHaveBeenCalledTimes(1);
			expect(wait).not.toHaveBeenCalled();
		}
	});
});
