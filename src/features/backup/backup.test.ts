import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { csvCell, minorToDecimal, recordsToCsv, toCsv } from "./csv";
import { crc32, createZipWriter, safeZipPath, ZipLimitError } from "./zip";

async function buildZip(
	files: Array<[string, Uint8Array | string, boolean?]>,
	maxBytes?: number,
) {
	const chunks: Uint8Array[] = [];
	const zip = createZipWriter(
		async (chunk) => {
			chunks.push(chunk.slice());
		},
		{ maxBytes },
	);
	for (const [name, data, compress] of files)
		await zip.add(name, data, { compress });
	const result = await zip.finish();
	const bytes = Buffer.concat(chunks);
	expect(bytes.byteLength).toBe(result.bytes);
	return bytes;
}

describe("zip writer", () => {
	it("produces an archive standard readers can open", async () => {
		const big = "row,value\n".repeat(5000);
		const binary = new Uint8Array(4096).map((_, i) => (i * 7919) % 256);
		const bytes = await buildZip([
			["data/orders.csv", big],
			["documents/2026/amazon_123/ünïcode invoice.pdf", binary, false],
			["data/orders.csv", "duplicate"],
		]);
		const archive = await JSZip.loadAsync(bytes);
		expect(Object.keys(archive.files).sort()).toEqual([
			"data/orders-2.csv",
			"data/orders.csv",
			"documents/2026/amazon_123/ünïcode invoice.pdf",
		]);
		expect(await archive.file("data/orders.csv")?.async("string")).toBe(big);
		expect(
			await archive
				.file("documents/2026/amazon_123/ünïcode invoice.pdf")
				?.async("uint8array"),
		).toEqual(binary);
		// Deflate actually shrank the repetitive CSV.
		expect(bytes.byteLength).toBeLessThan(big.length);
	});

	it("enforces the size bound", async () => {
		await expect(
			buildZip([["a.bin", new Uint8Array(20_000), false]], 10_000),
		).rejects.toBeInstanceOf(ZipLimitError);
	});

	it("computes standard CRC-32", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	it("sanitizes paths", () => {
		expect(safeZipPath("../../etc/passwd")).toBe("etc/passwd");
		expect(safeZipPath("/abs\\win:path?.pdf")).toBe("abs/win_path_.pdf");
		expect(safeZipPath("")).toBe("unnamed");
	});
});

describe("csv", () => {
	it("quotes and neutralizes formulas", () => {
		expect(csvCell('a,"b"')).toBe('"a,""b"""');
		expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
		expect(csvCell(-5)).toBe("-5");
		expect(csvCell(null)).toBe("");
		expect(toCsv(["x"], [["line\nbreak"]])).toBe('x\r\n"line\nbreak"\r\n');
	});
	it("flattens records with nested values as JSON", () => {
		expect(
			recordsToCsv([
				{ a: 1, b: { c: 2 } },
				{ a: 2, d: true },
			]),
		).toBe('a,b,d\r\n1,"{""c"":2}",\r\n2,,true\r\n');
	});
	it("formats minor units by currency exponent", () => {
		expect(minorToDecimal(123456, "USD")).toBe("1234.56");
		expect(minorToDecimal(-5, "USD")).toBe("-0.05");
		expect(minorToDecimal(1500, "JPY")).toBe("1500");
		expect(minorToDecimal(null)).toBe("");
	});
});
