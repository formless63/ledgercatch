import { beforeEach, describe, expect, it, vi } from "vitest";
import { browser } from "wxt/browser";
import { ingestDocument } from "@/background/ingest";
import { saveVisitedMouserInvoice } from "@/background/invoices";
import {
	clearMouserInvoiceOrders,
	orderForMouserInvoice,
	rememberMouserInvoiceOrders,
} from "@/background/mouser-invoices";
import { mouserInvoiceOrders, mouserPdfInvoiceNumber } from "@/lib/mouser-invoices";
import { parseSettings } from "@/lib/settings";

vi.mock("@/background/ingest", () => ({ ingestDocument: vi.fn().mockResolvedValue("doc"), ingestCapture: vi.fn() }));

const history = {
	aaData: [{ WebOrderNumber: "12345678", SalesOrderNumber: "87654321", Invoices: [{ InvoiceNumber: "10005555" }] }],
};
const url = "https://www.mouser.com/account/invoices/detail/10005555/pdf?hashId=SYNTHETIC";

beforeEach(async () => {
	vi.clearAllMocks();
	await browser.storage.local.clear();
	await browser.storage.local.set({
		settings: parseSettings({ serverUrl: "https://ledger.example.test", apiKey: "test" }),
	});
	vi.spyOn(browser.scripting, "executeScript").mockResolvedValue([
		{
			result: {
				ok: true,
				status: 200,
				finalUrl: url,
				contentType: "application/pdf",
				kind: "binary",
				base64: "JVBERi0xLjc=",
				size: 8,
				fileName: null,
			},
		},
	] as never);
});

describe("Mouser PDF navigation", () => {
	it("recognizes extensionless PDFs only on supported secure store domains", () => {
		expect(mouserPdfInvoiceNumber(url)).toBe("10005555");
		expect(mouserPdfInvoiceNumber(url.replace("www.mouser.com", "mouser.com.attacker.test"))).toBeUndefined();
		expect(mouserPdfInvoiceNumber(url.replace("https:", "http:"))).toBeUndefined();
	});
	it("maps an invoice to its Web Order, never the Sales Order or invoice number", async () => {
		expect(mouserInvoiceOrders(history)).toEqual({ "10005555": "12345678" });
		await rememberMouserInvoiceOrders(history);
		expect(await orderForMouserInvoice("10005555")).toBe("12345678");
		await saveVisitedMouserInvoice(3, url);
		expect(ingestDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				meta: expect.objectContaining({
					source: "mouser",
					externalOrderId: "12345678",
					kind: "invoice",
					fileName: "mouser-12345678.pdf",
				}),
				file: expect.any(Blob),
			}),
		);
		expect((vi.mocked(ingestDocument).mock.calls[0]?.[0].file as Blob).type).toBe("application/pdf");
	});
	it("deduplicates concurrent completion events after queueing bytes", async () => {
		await Promise.all([saveVisitedMouserInvoice(3, url), saveVisitedMouserInvoice(3, url)]);
		expect(ingestDocument).toHaveBeenCalledTimes(1);
	});
	it("honors passive capture and store settings", async () => {
		for (const patch of [{ passiveCapture: false }, { stores: { mouser: false } }, { apiKey: "" }]) {
			await browser.storage.local.set({ settings: parseSettings(patch) });
			await saveVisitedMouserInvoice(3, url);
		}
		expect(ingestDocument).not.toHaveBeenCalled();
	});
	it("rejects login HTML instead of saving a viewer shell", async () => {
		vi.mocked(browser.scripting.executeScript).mockResolvedValueOnce([
			{ result: { ok: true, status: 200, finalUrl: url, contentType: "text/html", kind: "html", links: [] } },
		] as never);
		await expect(saveVisitedMouserInvoice(3, url)).rejects.toThrow("Expected a PDF");
		expect(ingestDocument).not.toHaveBeenCalled();
	});
	it("clears identity mappings when settings change", async () => {
		await rememberMouserInvoiceOrders(history);
		await clearMouserInvoiceOrders();
		expect(await orderForMouserInvoice("10005555")).toBeUndefined();
	});
});
