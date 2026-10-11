import { MAX_HTML_BYTES, MAX_TEXT_BYTES, captureEnvelopeSchema } from "@app/shared/capture";
import { describe, expect, it } from "vitest";
import { type CaptureDraft, buildEnvelope, dedupeMaterial } from "@/lib/envelope";

const ctx = {
	captureId: "6f1c1e8e-8f43-4c5e-9d0e-0c6f3b7f2a11",
	capturedAt: "2026-10-08T12:00:00.000Z",
	extensionVersion: "0.1.0",
};

const htmlDraft: CaptureDraft = {
	source: "amazon",
	kind: "html_snapshot",
	trigger: "passive",
	pageType: "order_list",
	pageUrl: "https://user:pw@www.amazon.com/your-orders/orders#top",
	pageTitle: "Your Orders",
	orderIdHints: ["113-1111111-2222222", "113-1111111-2222222", " ", "x".repeat(200)],
	payload: { type: "html", html: "<html><body>hi</body></html>" },
};

describe("buildEnvelope", () => {
	it("builds a contract-valid envelope and sanitizes URL + hints", () => {
		const r = buildEnvelope(htmlDraft, ctx);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(captureEnvelopeSchema.safeParse(r.envelope).success).toBe(true);
		expect(r.envelope.schemaVersion).toBe(1);
		expect(r.envelope.pageUrl).toBe("https://www.amazon.com/your-orders/orders");
		expect(r.envelope.orderIdHints).toEqual(["113-1111111-2222222"]);
		expect(r.envelope.captureId).toBe(ctx.captureId);
	});

	it("rejects kind/payload mismatches", () => {
		const r = buildEnvelope({ ...htmlDraft, kind: "api_json" }, ctx);
		expect(r).toMatchObject({ ok: false });
	});

	it("rejects non-http page URLs", () => {
		expect(buildEnvelope({ ...htmlDraft, pageUrl: "chrome://extensions" }, ctx).ok).toBe(false);
	});

	it("rejects an invalid capture id via the contract schema", () => {
		const r = buildEnvelope(htmlDraft, { ...ctx, captureId: "nope" });
		expect(r.ok).toBe(false);
	});

	it("truncates oversized html and text to the contract limits", () => {
		const big = buildEnvelope({ ...htmlDraft, payload: { type: "html", html: "a".repeat(MAX_HTML_BYTES + 10) } }, ctx);
		expect(big.ok && big.envelope.payload.type === "html" && big.envelope.payload.html.length).toBe(MAX_HTML_BYTES);
		const text = buildEnvelope(
			{
				...htmlDraft,
				kind: "page_text",
				trigger: "manual",
				payload: { type: "text", text: "é".repeat(MAX_TEXT_BYTES), note: "  " },
			},
			ctx,
		);
		expect(text.ok).toBe(true);
		if (text.ok && text.envelope.payload.type === "text") {
			expect(new TextEncoder().encode(text.envelope.payload.text).byteLength).toBeLessThanOrEqual(MAX_TEXT_BYTES);
			expect(text.envelope.payload.note).toBeUndefined();
		}
	});

	it("strips credentials from intercepted request URLs", () => {
		const r = buildEnvelope(
			{
				...htmlDraft,
				kind: "api_json",
				payload: { type: "json", requestUrl: "https://a:b@acs.aliexpress.com/h5/x?t=1", body: { ok: 1 } },
			},
			ctx,
		);
		expect(r.ok && r.envelope.payload.type === "json" && r.envelope.payload.requestUrl).toBe("https://acs.aliexpress.com/h5/x?t=1");
	});

	it("rejects bad screenshot data URLs", () => {
		const r = buildEnvelope(
			{
				...htmlDraft,
				kind: "page_text",
				payload: { type: "text", text: "hello", screenshotDataUrl: "data:text/html;base64,AAAA" },
			},
			ctx,
		);
		expect(r.ok).toBe(false);
	});
});

describe("dedupeMaterial", () => {
	it("ignores volatile query params on JSON request URLs", () => {
		const base = { ...htmlDraft, kind: "api_json" as const };
		const a = dedupeMaterial({ ...base, payload: { type: "json", requestUrl: "https://acs.x.com/h5/api?t=1&sign=a", body: { a: 1 } } });
		const b = dedupeMaterial({ ...base, payload: { type: "json", requestUrl: "https://acs.x.com/h5/api?t=2&sign=b", body: { a: 1 } } });
		const c = dedupeMaterial({ ...base, payload: { type: "json", requestUrl: "https://acs.x.com/h5/api?t=2", body: { a: 2 } } });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});
});
