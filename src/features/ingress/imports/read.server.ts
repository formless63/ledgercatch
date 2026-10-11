/**
 * Reads uploaded spreadsheets into rows of text cells.
 *
 * - XLSX (zip) via exceljs; first non-empty sheet unless one is chosen.
 * - Legacy binary .xls is rejected with a "save as .xlsx/.csv" message, but
 *   ".xls" files that are really HTML tables or text (several stores do this)
 *   are read as such.
 * - CSV/TSV via papaparse with delimiter sniffing; encoding sniffed from the
 *   BOM (UTF-8, UTF-16 LE/BE), NUL patterns (BOM-less UTF-16) or falls back
 *   to Windows-1252 when the bytes are not valid UTF-8.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { loadHtml } from "#/features/parsing/html";

export class ImportFileError extends Error {}

export type SheetRead = {
	format: "csv" | "xlsx" | "html";
	sheets: string[];
	sheet: string | null;
	/** All rows read (header included), at most `maxRows`. */
	rows: string[][];
	/** True when the sheet had more rows than `maxRows`. */
	truncated: boolean;
};

export type ReadOptions = { sheet?: string | null; maxRows: number };

function startsWith(bytes: Uint8Array, signature: number[]) {
	return signature.every((byte, i) => bytes[i] === byte);
}

function swapPairs(bytes: Uint8Array) {
	const out = new Uint8Array(bytes.length - (bytes.length % 2));
	for (let i = 0; i + 1 < bytes.length; i += 2) {
		out[i] = bytes[i + 1] as number;
		out[i + 1] = bytes[i] as number;
	}
	return out;
}

/** Bytes → string with BOM/UTF-16/Windows-1252 sniffing. */
export function decodeText(bytes: Uint8Array): string {
	if (startsWith(bytes, [0xef, 0xbb, 0xbf]))
		return new TextDecoder("utf-8").decode(bytes.subarray(3));
	if (startsWith(bytes, [0xff, 0xfe]))
		return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	if (startsWith(bytes, [0xfe, 0xff]))
		return new TextDecoder("utf-16le").decode(swapPairs(bytes.subarray(2)));
	const sample = bytes.subarray(0, 4096);
	let evenZero = 0;
	let oddZero = 0;
	for (let i = 0; i < sample.length; i++)
		if (sample[i] === 0) i % 2 === 0 ? evenZero++ : oddZero++;
	const half = sample.length / 2;
	if (half > 0 && oddZero > half * 0.3 && evenZero < half * 0.05)
		return new TextDecoder("utf-16le").decode(bytes);
	if (half > 0 && evenZero > half * 0.3 && oddZero < half * 0.05)
		return new TextDecoder("utf-16le").decode(swapPairs(bytes));
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("windows-1252").decode(bytes);
	}
}

function trimRows(rows: string[][]): string[][] {
	return rows.map((row) => {
		let end = row.length;
		while (end > 0 && !(row[end - 1] ?? "").trim()) end--;
		return row.slice(0, end).map((cell) => cell ?? "");
	});
}

export function readDelimited(text: string, maxRows: number): SheetRead {
	const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
		delimiter: "",
		delimitersToGuess: [",", ";", "\t", "|"],
		skipEmptyLines: "greedy",
		preview: maxRows + 1,
	});
	const rows = trimRows(parsed.data.map((row) => row.map((c) => String(c))));
	const truncated = rows.length > maxRows;
	return {
		format: "csv",
		sheets: [],
		sheet: null,
		rows: truncated ? rows.slice(0, maxRows) : rows,
		truncated,
	};
}

export function readHtmlTable(html: string, maxRows: number): SheetRead {
	const $ = loadHtml(html);
	let best: string[][] = [];
	$("table").each((_, table) => {
		const rows: string[][] = [];
		$(table)
			.find("tr")
			.each((__, tr) => {
				// Skip rows that belong to a nested table.
				if ($(tr).closest("table")[0] !== table) return;
				rows.push(
					$(tr)
						.children("th,td")
						.toArray()
						.map((cell) => $(cell).text().replace(/\s+/g, " ").trim()),
				);
			});
		if (rows.length > best.length) best = rows;
	});
	if (!best.length) throw new ImportFileError("No table found in the file");
	const rows = trimRows(best).filter((row) => row.some(Boolean));
	return {
		format: "html",
		sheets: [],
		sheet: null,
		rows: rows.slice(0, maxRows),
		truncated: rows.length > maxRows,
	};
}

function pad(n: number) {
	return String(n).padStart(2, "0");
}

/** exceljs cell value → display text. */
export function excelCellText(value: ExcelJS.CellValue): string {
	if (value == null) return "";
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) return "";
		const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
		const hasTime =
			value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds();
		return hasTime
			? `${date}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
			: date;
	}
	if (typeof value === "number")
		return Number.isInteger(value) ? String(value) : String(+value.toFixed(10));
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "object") {
		if ("richText" in value && Array.isArray(value.richText))
			return value.richText.map((part) => part.text).join("");
		if ("formula" in value || "sharedFormula" in value)
			return excelCellText(
				(value as { result?: ExcelJS.CellValue }).result ?? null,
			);
		if ("hyperlink" in value) {
			const link = value as { text?: unknown; hyperlink?: string };
			const text =
				typeof link.text === "string"
					? link.text
					: excelCellText(link.text as ExcelJS.CellValue);
			return text || link.hyperlink || "";
		}
		if ("error" in value) return "";
	}
	return String(value);
}

export async function readXlsx(
	bytes: Uint8Array,
	options: ReadOptions,
): Promise<SheetRead> {
	const workbook = new ExcelJS.Workbook();
	try {
		await workbook.xlsx.load(
			bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer,
		);
	} catch (error) {
		throw new ImportFileError(
			`Could not read the Excel file: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const worksheets = workbook.worksheets.filter(
		(sheet) => sheet.state !== "veryHidden",
	);
	if (!worksheets.length) throw new ImportFileError("The workbook is empty");
	const sheets = worksheets.map((sheet) => sheet.name);
	const chosen =
		(options.sheet && worksheets.find((s) => s.name === options.sheet)) ||
		worksheets.find((s) => s.state !== "hidden" && s.actualRowCount > 0) ||
		worksheets[0];
	if (!chosen) throw new ImportFileError("The workbook is empty");
	const rows: string[][] = [];
	const last = chosen.rowCount;
	let truncated = false;
	for (let r = 1; r <= last; r++) {
		const row = chosen.getRow(r);
		const cells: string[] = [];
		const count = row.cellCount;
		for (let c = 1; c <= count; c++)
			cells.push(excelCellText(row.getCell(c).value).trim());
		if (!cells.some(Boolean)) continue;
		if (rows.length >= options.maxRows) {
			truncated = true;
			break;
		}
		rows.push(cells);
	}
	return {
		format: "xlsx",
		sheets,
		sheet: chosen.name,
		rows: trimRows(rows),
		truncated,
	};
}

export const SPREADSHEET_EXTENSIONS = /\.(csv|tsv|txt|xlsx|xlsm|xls)$/i;

export async function readSpreadsheet(
	bytes: Uint8Array,
	fileName: string,
	options: ReadOptions,
): Promise<SheetRead> {
	if (!bytes.byteLength) throw new ImportFileError("The file is empty");
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]))
		return readXlsx(bytes, options);
	if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]))
		throw new ImportFileError(
			"Legacy .xls (Excel 97–2003) files are not supported. Open it and save as .xlsx or .csv.",
		);
	const text = decodeText(bytes);
	if (/<table[\s>]/i.test(text.slice(0, 200_000)))
		return readHtmlTable(text, options.maxRows);
	if (/\.xlsx?$/i.test(fileName) && text.includes("\u0000"))
		throw new ImportFileError("Unrecognized Excel file format");
	return readDelimited(text, options.maxRows);
}

const NUMERICISH = /^[-+(]?[$€£¥]?\s?[\d.,\s'/:-]+\)?%?$/;

/**
 * Index of the header row: the first of the top 20 rows that is mostly
 * filled with non-numeric labels. Store exports often start with a title,
 * account or date-range lines.
 */
export function findHeaderRow(rows: string[][]): number {
	const width = Math.max(0, ...rows.slice(0, 50).map((row) => row.length));
	for (let i = 0; i < Math.min(rows.length, 20); i++) {
		const cells = (rows[i] ?? []).map((c) => c.trim()).filter(Boolean);
		if (cells.length < Math.max(2, Math.ceil(width * 0.5))) continue;
		const numeric = cells.filter((c) => NUMERICISH.test(c)).length;
		const unique = new Set(cells.map((c) => c.toLowerCase())).size;
		if (numeric / cells.length <= 0.2 && unique >= cells.length * 0.8) return i;
	}
	return 0;
}

/** Splits rows into a header (unique, non-empty names) and data rows. */
export function splitHeader(rows: string[][], headerRow?: number) {
	const index =
		headerRow !== undefined && headerRow >= 0 && headerRow < rows.length
			? headerRow
			: findHeaderRow(rows);
	const raw = rows[index] ?? [];
	const width = Math.max(
		raw.length,
		...rows.slice(index + 1, index + 51).map((row) => row.length),
	);
	const seen = new Map<string, number>();
	const headers = Array.from({ length: width }, (_, i) => {
		const base = (raw[i] ?? "").replace(/^﻿/, "").trim() || `Column ${i + 1}`;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		return count ? `${base} (${count + 1})` : base;
	});
	return { headerRow: index, headers, data: rows.slice(index + 1) };
}
