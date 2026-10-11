import { describe, expect, it } from "vitest";
import { parseDate } from "./dates";
import { normalizeStatus } from "./status";

describe("parseDate", () => {
	it.each([
		["October 3, 2026", "2026-10-03"],
		["Ordered on October 26, 2020", "2020-10-26"],
		["3 Oct 2026", "2026-10-03"],
		["Oct 03, 2026", "2026-10-03"],
		["Oct. 3 2026", "2026-10-03"],
		["Sept 3, 2026", "2026-09-03"],
		["2026-10-03", "2026-10-03"],
		["2026-10-03T23:10:00Z", "2026-10-03"],
		["03.10.2026", "2026-10-03"],
		["14. März 2026", "2026-03-14"],
		["3. Oktober 2026", "2026-10-03"],
		["14 March 2026", "2026-03-14"],
		["3rd October, 2026", "2026-10-03"],
		["14-Mar-26", "2026-03-14"],
		["Mar 14, 2021 at 3:17 PM", "2021-03-14"],
		["2026/10/03", "2026-10-03"],
		["2026年10月3日", "2026-10-03"],
		["10/03/2026", "2026-10-03"],
		["25/12/2025", "2025-12-25"],
		["3 de octubre de 2026", "2026-10-03"],
	])("%s → %s", (text, expected) => {
		expect(parseDate(text)).toBe(expected);
	});

	it("respects dayFirst for ambiguous numeric dates", () => {
		expect(parseDate("03/10/2026", { dayFirst: true })).toBe("2026-10-03");
		expect(parseDate("03/10/2026")).toBe("2026-03-10");
	});

	it("handles epochs and rejects junk", () => {
		expect(parseDate(1791158400000)).toBe("2026-10-05");
		expect(parseDate("1791158400")).toBe("2026-10-05");
		expect(parseDate("Arriving Friday")).toBeUndefined();
		expect(parseDate("February 30, 2026")).toBeUndefined();
		expect(parseDate("")).toBeUndefined();
		expect(parseDate(undefined)).toBeUndefined();
	});
});

describe("normalizeStatus", () => {
	it.each([
		["Delivered October 5", "delivered"],
		["Delivered Oct 2, 2026 Return window closed on Nov 1", "delivered"],
		["Completed", "delivered"],
		["Awaiting delivery", "shipped"],
		["Shipped", "shipped"],
		["Out for delivery", "shipped"],
		["Not yet shipped", "processing"],
		["Awaiting shipment", "processing"],
		["Arriving tomorrow", "processing"],
		["Awaiting payment", "placed"],
		["Order received", "placed"],
		["Cancelled", "cancelled"],
		["Canceled", "cancelled"],
		["Closed", "cancelled"],
		["Refunded", "returned"],
		["Return complete", "returned"],
		["Zugestellt", "delivered"],
		["Storniert", "cancelled"],
		["Something odd", "unknown"],
	] as const)("%s → %s", (text, expected) => {
		expect(normalizeStatus(text)).toBe(expected);
	});
	it("returns undefined for empty input", () => {
		expect(normalizeStatus("  ")).toBeUndefined();
	});
});
