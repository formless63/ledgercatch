/** Client-safe, dependency-free CSV writer (RFC 4180, formula-injection safe). */

export type CsvValue = string | number | boolean | null | undefined | Date;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
	if (value === null || value === undefined) return "";
	let text: string;
	if (value instanceof Date) text = value.toISOString();
	else if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : "";
	else if (typeof value === "boolean") return value ? "true" : "false";
	else text = value;
	// Spreadsheet apps execute cells starting with = + - @; neutralize text only.
	if (FORMULA_START.test(text)) text = `'${text}`;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(
	headers: readonly string[],
	rows: ReadonlyArray<ReadonlyArray<CsvValue>>,
): string {
	const lines = [headers.map(csvCell).join(",")];
	for (const row of rows) lines.push(row.map(csvCell).join(","));
	return `${lines.join("\r\n")}\r\n`;
}

/** Objects → CSV using the union of keys (first-seen order). Nested values become JSON. */
export function recordsToCsv(records: ReadonlyArray<Record<string, unknown>>) {
	const headers: string[] = [];
	const seen = new Set<string>();
	for (const record of records)
		for (const key of Object.keys(record))
			if (!seen.has(key)) {
				seen.add(key);
				headers.push(key);
			}
	return toCsv(
		headers,
		records.map((record) =>
			headers.map((key) => {
				const value = record[key];
				if (
					value === null ||
					value === undefined ||
					value instanceof Date ||
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean"
				)
					return value;
				return JSON.stringify(value);
			}),
		),
	);
}

export function currencyExponent(currency: string | null | undefined) {
	try {
		return (
			new Intl.NumberFormat("en", {
				style: "currency",
				currency: (currency || "USD").toUpperCase(),
			}).resolvedOptions().maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
}

/** Minor units → plain decimal string for spreadsheets ("1234.50"). */
export function minorToDecimal(
	minor: number | null | undefined,
	currency?: string | null,
) {
	if (minor === null || minor === undefined) return "";
	const exponent = currencyExponent(currency);
	const negative = minor < 0;
	const digits = String(Math.abs(Math.trunc(minor))).padStart(
		exponent + 1,
		"0",
	);
	const whole = digits.slice(0, digits.length - exponent);
	const fraction = exponent > 0 ? `.${digits.slice(-exponent)}` : "";
	return `${negative ? "-" : ""}${whole}${fraction}`;
}
