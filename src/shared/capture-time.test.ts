import { describe, expect, it } from "vitest";
import { captureLocalDate, formatCaptureTimestamp } from "./capture-time";

describe("capture local calendar date", () => {
	it.each([
		[
			"2026-10-09T01:30:00Z",
			240,
			"2026-10-08T21:30:00.000-04:00",
			"2026-10-08",
		],
		[
			"2026-10-08T20:30:00Z",
			-330,
			"2026-10-09T02:00:00.000+05:30",
			"2026-10-09",
		],
		["2026-10-09T01:30:00Z", 0, "2026-10-09T01:30:00.000+00:00", "2026-10-09"],
	])("preserves instant and local date for %s at offset %s", (instant, offset, expected, day) => {
		const formatted = formatCaptureTimestamp(new Date(instant), offset);
		expect(formatted).toBe(expected);
		expect(new Date(formatted).toISOString()).toBe(
			new Date(instant).toISOString(),
		);
		expect(captureLocalDate(formatted)).toBe(day);
	});

	it("does not infer a local date for legacy UTC-only or malformed timestamps", () => {
		expect(captureLocalDate("2026-10-09T01:30:00.000Z")).toBeUndefined();
		expect(captureLocalDate("2026-10-09")).toBeUndefined();
		expect(captureLocalDate("invalid-04:00")).toBeUndefined();
	});
});
