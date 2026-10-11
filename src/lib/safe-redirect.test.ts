import { describe, expect, it } from "vitest";
import { safeInternalRedirect } from "./safe-redirect";

describe("safeInternalRedirect", () => {
	it("preserves internal paths including query strings and fragments", () => {
		expect(safeInternalRedirect("/app/projects?view=recent#saved")).toBe(
			"/app/projects?view=recent#saved",
		);
	});

	it.each([
		"https://example.com/steal",
		"//example.com/steal",
		"/\\example.com/steal",
		undefined,
	])("rejects an off-site or absent target: %s", (target) => {
		expect(safeInternalRedirect(target)).toBe("/app");
	});
});
