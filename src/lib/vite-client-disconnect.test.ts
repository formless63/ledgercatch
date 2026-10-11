import { describe, expect, it } from "vitest";
import { isClientDisconnect } from "../../scripts/vite-client-disconnect";

describe("development client disconnect classification", () => {
	it("only classifies ECONNRESET on an already aborted transport", () => {
		expect(isClientDisconnect({ code: "ECONNRESET" }, { aborted: true })).toBe(
			true,
		);
		expect(isClientDisconnect({ code: "ECONNRESET" }, { aborted: false })).toBe(
			false,
		);
		for (const error of [
			null,
			undefined,
			"aborted",
			new Error("compiler failure"),
			{ code: "EPIPE" },
		]) {
			expect(isClientDisconnect(error, { aborted: true })).toBe(false);
		}
	});
});
