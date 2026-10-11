import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
	decodeText,
	findHeaderRow,
	ImportFileError,
	readSpreadsheet,
	splitHeader,
} from "./read.server";

const enc = (s: string) => new TextEncoder().encode(s);
function utf16le(s: string, bom = true) {
	const out = new Uint8Array(s.length * 2 + (bom ? 2 : 0));
	let o = 0;
	if (bom) {
		out[0] = 0xff;
		out[1] = 0xfe;
		o = 2;
	}
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		out[o + i * 2] = code & 0xff;
		out[o + i * 2 + 1] = code >> 8;
	}
	return out;
}

describe("decodeText", () => {
	it("handles BOMs, BOM-less UTF-16 and Windows-1252", () => {
		expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("a,b")]))).toBe(
			"a,b",
		);
		expect(decodeText(utf16le("Größe,€"))).toBe("Größe,€");
		expect(decodeText(utf16le("Order ID,Total\n1,2", false))).toBe(
			"Order ID,Total\n1,2",
		);
		const be = utf16le("ab", false);
		const swapped = new Uint8Array([
			0xfe,
			0xff,
			be[1] ?? 0,
			be[0] ?? 0,
			be[3] ?? 0,
			be[2] ?? 0,
		]);
		expect(decodeText(swapped)).toBe("ab");
		expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe("café");
	});
});

describe("readSpreadsheet", () => {
	it("sniffs semicolons and tabs", async () => {
		const semi = await readSpreadsheet(
			enc('Order;Total\n1;"1,50"\n'),
			"a.csv",
			{ maxRows: 10 },
		);
		expect(semi.rows).toEqual([
			["Order", "Total"],
			["1", "1,50"],
		]);
		const tsv = await readSpreadsheet(
			utf16le("Order\tTotal\r\n1\t2\r\n"),
			"a.txt",
			{ maxRows: 10 },
		);
		expect(tsv.rows).toEqual([
			["Order", "Total"],
			["1", "2"],
		]);
	});

	it("bounds rows and reports truncation", async () => {
		const body = [
			"A,B",
			...Array.from({ length: 20 }, (_, i) => `${i},x`),
		].join("\n");
		const read = await readSpreadsheet(enc(body), "a.csv", { maxRows: 5 });
		expect(read.rows).toHaveLength(5);
		expect(read.truncated).toBe(true);
	});

	it("reads HTML tables disguised as .xls", async () => {
		const html =
			"<html><body><table><tr><th>Mouser #</th><th>Qty</th></tr><tr><td>595-NE555P</td><td>2</td></tr></table></body></html>";
		const read = await readSpreadsheet(enc(html), "order.xls", { maxRows: 10 });
		expect(read.format).toBe("html");
		expect(read.rows).toEqual([
			["Mouser #", "Qty"],
			["595-NE555P", "2"],
		]);
	});

	it("rejects legacy BIFF .xls", async () => {
		await expect(
			readSpreadsheet(
				new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
				"a.xls",
				{ maxRows: 10 },
			),
		).rejects.toBeInstanceOf(ImportFileError);
	});

	it("reads XLSX sheets with dates, numbers, formulas and rich text", async () => {
		const workbook = new ExcelJS.Workbook();
		const notes = workbook.addWorksheet("Notes");
		notes.addRow(["hello"]);
		const sheet = workbook.addWorksheet("Orders");
		sheet.addRow(["Mouser Order Export"]);
		sheet.addRow(["Web Order #", "Order Date", "Qty", "Ext.: (USD)", "Desc."]);
		sheet.addRow([
			"267123456",
			new Date(Date.UTC(2024, 2, 5)),
			3,
			{ formula: "3*1.5", result: 4.5 },
			{ richText: [{ text: "NE555 " }, { text: "timer" }] },
		]);
		const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

		const first = await readSpreadsheet(bytes, "x.xlsx", { maxRows: 100 });
		expect(first.sheets).toEqual(["Notes", "Orders"]);
		expect(first.sheet).toBe("Notes");

		const read = await readSpreadsheet(bytes, "x.xlsx", {
			sheet: "Orders",
			maxRows: 100,
		});
		expect(read.format).toBe("xlsx");
		const { headerRow, headers, data } = splitHeader(read.rows);
		expect(headerRow).toBe(1);
		expect(headers).toEqual([
			"Web Order #",
			"Order Date",
			"Qty",
			"Ext.: (USD)",
			"Desc.",
		]);
		expect(data).toEqual([
			["267123456", "2024-03-05", "3", "4.5", "NE555 timer"],
		]);
	});
});

describe("header detection", () => {
	it("skips title and metadata lines", () => {
		const rows = [
			["Order History"],
			["Account", "12345"],
			["Order", "Date", "Total", "Status"],
			["1", "2024-01-01", "1.00", "Shipped"],
		];
		expect(findHeaderRow(rows)).toBe(2);
	});
	it("dedupes and fills header names", () => {
		const { headers } = splitHeader(
			[
				["A", "", "A"],
				["1", "2", "3", "4"],
			],
			0,
		);
		expect(headers).toEqual(["A", "Column 2", "A (2)", "Column 4"]);
	});
});
