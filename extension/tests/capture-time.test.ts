import { formatCaptureTimestamp } from "@app/shared/capture-time";
import { describe, expect, it } from "vitest";
import { buildEnvelope } from "@/lib/envelope";

describe("capture timestamp contract", () => {
	it.each([240, -330, 0])("accepts a client offset of %s without normalizing it", (offset) => {
		const capturedAt = formatCaptureTimestamp(new Date("2026-10-09T01:30:00Z"), offset);
		const result = buildEnvelope(
			{
				source: "ebay",
				kind: "html_snapshot",
				trigger: "passive",
				pageType: "order_confirmation",
				pageUrl: "https://pay.ebay.com/rxo?action=success",
				pageTitle: "Checkout",
				orderIdHints: [],
				payload: { type: "html", html: "<html><body>Order confirmation</body></html>" },
			},
			{ captureId: "6f1c1e8e-8f43-4c5e-9d0e-0c6f3b7f2a11", capturedAt, extensionVersion: "0.1.0" },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.envelope.capturedAt).toBe(capturedAt);
	});
});
