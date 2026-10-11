import { describe, expect, it } from "vitest";
import { debuggerPermissionEnabled } from "../src/lib/build-flags";
import { invoiceDocumentHtml } from "../src/lib/html";

describe("EXT_DEBUGGER_PERMISSION", () => {
	it("is off by default and for anything but an explicit opt-in", () => {
		expect(debuggerPermissionEnabled(undefined)).toBe(false);
		expect(debuggerPermissionEnabled("")).toBe(false);
		expect(debuggerPermissionEnabled("off")).toBe(false);
		expect(debuggerPermissionEnabled("optional")).toBe(false);
	});
	it("accepts the opt-in spellings", () => {
		for (const v of ["required", "REQUIRED", " on ", "true", "1"]) expect(debuggerPermissionEnabled(v), v).toBe(true);
	});
});

describe("invoiceDocumentHtml", () => {
	it("drops every script but keeps styles and markup", () => {
		const html =
			'<html><head><style>td{color:red}</style><script>alert(1)</script><script src="x.js"></script></head>' +
			'<body><noscript>enable js</noscript><table><tr><td>Total $5</td></tr></table></body></html>';
		const out = invoiceDocumentHtml(html, 1_000_000);
		expect(out).not.toContain("<script");
		expect(out).not.toContain("noscript");
		expect(out).toContain("td{color:red}");
		expect(out).toContain("Total $5");
	});
});
