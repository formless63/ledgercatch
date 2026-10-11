/**
 * Card / bank statement parsing (pure, client-safe).
 *
 * Every parser returns StatementRow objects normalized to one convention:
 * **charges are positive, credits (refunds, payments) are negative**.
 *
 * - Spreadsheets (CSV/XLSX rows): bank presets with their sign conventions,
 *   plus a generic date/description/amount (or debit/credit) mapper.
 * - OFX / QFX: SGML (v1) and XML (v2) STMTTRN blocks.
 * - QIF: !Type:CCard / !Type:Bank records.
 */
import { normalizeHeader } from "#/features/ingress/imports/presets";
import { parseDate } from "#/features/parsing/dates";
import {
	minorDigits,
	normalizeCurrencyCode,
	parseDecimalString,
	parseMoney,
} from "#/features/parsing/money";
import type { TransactionKind } from "./schema";

export type SignConvention = "charges_positive" | "charges_negative";

export type StatementRow = {
	/** Transaction date (ISO). */
	date: string;
	description: string;
	/** Charges positive, credits negative. */
	amountMinor: number;
	currency: string;
	kind: TransactionKind;
	externalId?: string;
	/** Account / card number tail found on the row. */
	accountHint?: string;
	raw: Record<string, string>;
};

export type StatementParseResult = {
	format: "csv" | "xlsx" | "html" | "ofx" | "qif";
	presetId: string | null;
	presetLabel: string;
	rows: StatementRow[];
	errors: Array<{ row: number; message: string }>;
	skipped: number;
	/** Sign convention used (detected or chosen) for single-amount columns. */
	signConvention: SignConvention | null;
	accountHint: string | null;
	currency: string;
};

export type StatementParseOptions = {
	presetId?: string | null;
	signConvention?: SignConvention | null;
	/** Currency for amounts without a marker (default USD). */
	currency?: string | null;
	dayFirst?: boolean;
};

/* ───────────────────────── shared helpers ───────────────────────── */

const PAYMENT_RE =
	/\b(autopay|auto[\s-]pay|payment\s*-?\s*thank\s*you|thank you for your payment|online payment|mobile payment|payment received|electronic payment|ach\s*(?:pmt|payment)|e-?payment|directpay|internet payment|automatic payment|card payment|credit card payment|pymt)\b/i;

/** Classifies a row from its bank type text, description and sign. */
export function classifyKind(
	amountMinor: number,
	description: string,
	typeText = "",
): TransactionKind {
	const type = typeText.toLowerCase();
	if (/payment|autopay/.test(type) || PAYMENT_RE.test(description))
		return "payment";
	if (/\bfee\b|interest|finance charge|srvchg|\bint\b/.test(type)) return "fee";
	if (
		/^(fee|interest charge|late fee|annual fee|foreign transaction fee)/i.test(
			description,
		)
	)
		return "fee";
	if (/transfer|xfer/.test(type)) return "other";
	if (amountMinor < 0) return "credit";
	return "charge";
}

function last4(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const digits = text.replace(/\D/g, "");
	return digits.length >= 4 ? digits.slice(-4) : undefined;
}

function amountFrom(
	text: string | undefined,
	currency: string,
): number | undefined {
	const cell = (text ?? "").trim();
	if (!cell) return undefined;
	return parseMoney(cell, { currency })?.amountMinor;
}

/* ───────────────────────── spreadsheet presets ───────────────────────── */

type AmountSpec =
	| { kind: "single"; columns: string[]; sign: SignConvention | "detect" }
	| { kind: "debit_credit"; debit: string[]; credit: string[] };

export type StatementPreset = {
	id: string;
	label: string;
	/** Normalized headers that must all be present. */
	required: string[];
	/** At least one of these must be present (when given). */
	anyOf?: string[];
	date: string[];
	description: string[];
	amount: AmountSpec;
	currency?: string[];
	card?: string[];
	type?: string[];
	externalId?: string[];
	/** Rows to drop (non-purchases like PayPal currency conversions). */
	skip?: (cell: (names: string[]) => string) => boolean;
};

export const STATEMENT_PRESETS: StatementPreset[] = [
	{
		id: "chase_card",
		label: "Chase credit card",
		required: [
			"transaction date",
			"post date",
			"description",
			"type",
			"amount",
		],
		date: ["transaction date", "post date"],
		description: ["description"],
		amount: { kind: "single", columns: ["amount"], sign: "charges_negative" },
		type: ["type"],
	},
	{
		id: "chase_bank",
		label: "Chase checking",
		required: ["details", "posting date", "description", "amount", "type"],
		date: ["posting date"],
		description: ["description"],
		amount: { kind: "single", columns: ["amount"], sign: "charges_negative" },
		type: ["type"],
	},
	{
		id: "amex",
		label: "American Express",
		required: ["date", "description", "amount"],
		anyOf: [
			"card member",
			"extended details",
			"appears on your statement as",
			"account",
		],
		date: ["date"],
		description: ["description", "appears on your statement as"],
		amount: { kind: "single", columns: ["amount"], sign: "charges_positive" },
		card: ["account", "account number"],
		externalId: ["reference"],
	},
	{
		id: "capital_one",
		label: "Capital One",
		required: [
			"transaction date",
			"posted date",
			"description",
			"debit",
			"credit",
		],
		anyOf: ["card no", "card number"],
		date: ["transaction date", "posted date"],
		description: ["description"],
		amount: { kind: "debit_credit", debit: ["debit"], credit: ["credit"] },
		card: ["card no", "card number"],
	},
	{
		id: "citi",
		label: "Citi",
		required: ["status", "date", "description", "debit", "credit"],
		date: ["date"],
		description: ["description"],
		amount: { kind: "debit_credit", debit: ["debit"], credit: ["credit"] },
		card: ["member name"],
	},
	{
		id: "discover",
		label: "Discover",
		required: ["trans date", "post date", "description", "amount"],
		date: ["trans date", "post date"],
		description: ["description"],
		amount: { kind: "single", columns: ["amount"], sign: "charges_positive" },
		type: ["category"],
	},
	{
		id: "apple_card",
		label: "Apple Card",
		required: [
			"transaction date",
			"clearing date",
			"description",
			"merchant",
			"type",
		],
		anyOf: ["amount usd", "amount"],
		date: ["transaction date", "clearing date"],
		description: ["merchant", "description"],
		amount: {
			kind: "single",
			columns: ["amount usd", "amount"],
			sign: "charges_positive",
		},
		type: ["type"],
	},
	{
		id: "paypal",
		label: "PayPal activity",
		required: ["date", "name", "type", "status", "currency", "gross"],
		date: ["date"],
		description: ["name", "item title"],
		amount: { kind: "single", columns: ["gross"], sign: "charges_negative" },
		currency: ["currency"],
		type: ["type"],
		externalId: ["transaction id"],
		skip: (cell) =>
			/currency conversion|deposit|withdrawal|hold|transfer|authori[sz]ation|reversal of general account hold|bank account|card funding/i.test(
				cell(["type"]),
			) ||
			/^(denied|failed|removed|canceled|cancelled)$/i.test(cell(["status"])),
	},
	{
		id: "generic",
		label: "Generic (date, description, amount)",
		required: [],
		date: [
			"transaction date",
			"trans date",
			"date",
			"posted date",
			"post date",
			"posting date",
			"booking date",
			"value date",
		],
		description: [
			"description",
			"merchant",
			"payee",
			"name",
			"details",
			"narrative",
			"memo",
			"transaction description",
		],
		amount: {
			kind: "single",
			columns: ["amount", "transaction amount", "amount usd", "value"],
			sign: "detect",
		},
		currency: ["currency", "currency code"],
		card: ["card no", "card number", "card", "account number"],
		type: ["type", "transaction type"],
		externalId: ["reference", "transaction id", "id"],
	},
];

const GENERIC_DEBIT = [
	"debit",
	"debits",
	"withdrawal",
	"withdrawals",
	"money out",
	"paid out",
	"charge",
	"charges",
];
const GENERIC_CREDIT = [
	"credit",
	"credits",
	"deposit",
	"deposits",
	"money in",
	"paid in",
];

export function getStatementPreset(id: string | null | undefined) {
	return STATEMENT_PRESETS.find((preset) => preset.id === id);
}

/** Best preset for these headers (most required columns), else generic. */
export function detectStatementPreset(headers: string[]): StatementPreset {
	const names = new Set(headers.map(normalizeHeader));
	let best: StatementPreset | undefined;
	for (const preset of STATEMENT_PRESETS) {
		if (!preset.required.length) continue;
		if (!preset.required.every((header) => names.has(header))) continue;
		if (preset.anyOf && !preset.anyOf.some((header) => names.has(header)))
			continue;
		if (!best || preset.required.length > best.required.length) best = preset;
	}
	return best ?? (getStatementPreset("generic") as StatementPreset);
}

function columnIndex(headers: string[], candidates: string[]) {
	const normalized = headers.map(normalizeHeader);
	for (const candidate of candidates) {
		const index = normalized.indexOf(candidate);
		if (index >= 0) return index;
	}
	return -1;
}

/** Charges-positive amount from a sign convention. */
function applySign(minor: number, sign: SignConvention) {
	return sign === "charges_negative" ? -minor : minor;
}

/** Majority of non-zero amounts negative → the bank shows charges negative. */
export function detectSignConvention(amounts: number[]): SignConvention {
	const nonZero = amounts.filter((amount) => amount !== 0);
	if (!nonZero.length) return "charges_positive";
	const negative = nonZero.filter((amount) => amount < 0).length;
	return negative / nonZero.length > 0.6
		? "charges_negative"
		: "charges_positive";
}

export function parseStatementRows(
	headers: string[],
	data: string[][],
	options: StatementParseOptions & {
		format?: "csv" | "xlsx" | "html";
		firstRowNumber?: number;
	} = {},
): StatementParseResult {
	const preset =
		getStatementPreset(options.presetId) ?? detectStatementPreset(headers);
	const fallbackCurrency = normalizeCurrencyCode(options.currency) ?? "USD";
	const col = (candidates: string[] | undefined) =>
		candidates ? columnIndex(headers, candidates) : -1;
	const dateCols = preset.date.map((name) => col([name])).filter((i) => i >= 0);
	const descriptionCols = preset.description
		.map((name) => col([name]))
		.filter((i) => i >= 0);
	const currencyCol = col(preset.currency);
	const cardCol = col(preset.card);
	const typeCol = col(preset.type);
	const idCol = col(preset.externalId);
	let amount = preset.amount;
	if (preset.id === "generic") {
		const single = col(amount.kind === "single" ? amount.columns : []);
		const debit = col(GENERIC_DEBIT);
		const credit = col(GENERIC_CREDIT);
		if (single < 0 && (debit >= 0 || credit >= 0))
			amount = {
				kind: "debit_credit",
				debit: GENERIC_DEBIT,
				credit: GENERIC_CREDIT,
			};
	}
	const errors: StatementParseResult["errors"] = [];
	const first = options.firstRowNumber ?? 2;
	if (!dateCols.length || !descriptionCols.length)
		return {
			format: options.format ?? "csv",
			presetId: preset.id,
			presetLabel: preset.label,
			rows: [],
			errors: [
				{
					row: first - 1,
					message:
						"Could not find date and description columns. Pick a preset or check the header row.",
				},
			],
			skipped: 0,
			signConvention: null,
			accountHint: null,
			currency: fallbackCurrency,
		};

	type Pending = {
		index: number;
		date: string;
		description: string;
		signed: number;
		currency: string;
		raw: Record<string, string>;
		cells: string[];
	};
	const pending: Pending[] = [];
	let skipped = 0;
	data.forEach((cells, index) => {
		if (!cells.some((cell) => (cell ?? "").trim())) return;
		const cell = (names: string[]) => {
			const i = col(names);
			return i >= 0 ? (cells[i] ?? "").trim() : "";
		};
		if (preset.skip?.(cell)) {
			skipped++;
			return;
		}
		const rowNumber = first + index;
		const dateText = dateCols.map((i) => cells[i] ?? "").find((v) => v.trim());
		const date = parseDate(dateText, { dayFirst: options.dayFirst });
		const description = descriptionCols
			.map((i) => (cells[i] ?? "").trim())
			.find(Boolean);
		const currency =
			normalizeCurrencyCode(
				currencyCol >= 0 ? cells[currencyCol] : undefined,
			) ?? fallbackCurrency;
		let signed: number | undefined;
		if (amount.kind === "single") {
			const i = col(amount.columns);
			signed = i >= 0 ? amountFrom(cells[i], currency) : undefined;
		} else {
			const debit = amountFrom(cells[col(amount.debit)], currency);
			const credit = amountFrom(cells[col(amount.credit)], currency);
			if (debit !== undefined || credit !== undefined)
				// Already charges-positive.
				signed = Math.abs(debit ?? 0) - Math.abs(credit ?? 0);
		}
		if (!date || !description || signed === undefined) {
			// Footer/summary lines without a date are noise, not errors.
			if (!date && !dateText?.trim()) {
				skipped++;
				return;
			}
			errors.push({
				row: rowNumber,
				message: !date
					? `Unreadable date "${dateText ?? ""}"`
					: !description
						? "Missing description"
						: "Missing amount",
			});
			return;
		}
		const raw: Record<string, string> = {};
		headers.forEach((header, i) => {
			const value = (cells[i] ?? "").trim();
			if (value) raw[header] = value;
		});
		pending.push({
			index: rowNumber,
			date,
			description,
			signed,
			currency,
			raw,
			cells,
		});
	});

	let sign: SignConvention | null = null;
	if (amount.kind === "single") {
		sign =
			options.signConvention ??
			(amount.sign === "detect"
				? detectSignConvention(pending.map((row) => row.signed))
				: amount.sign);
	}
	const rows: StatementRow[] = pending.map((row) => {
		const amountMinor =
			amount.kind === "single" && sign
				? applySign(row.signed, sign)
				: row.signed;
		const typeText = typeCol >= 0 ? (row.cells[typeCol] ?? "") : "";
		const accountHint = cardCol >= 0 ? last4(row.cells[cardCol]) : undefined;
		const externalId = idCol >= 0 ? (row.cells[idCol] ?? "").trim() : "";
		return {
			date: row.date,
			description: row.description,
			amountMinor,
			currency: row.currency,
			kind: classifyKind(amountMinor, row.description, typeText),
			...(externalId ? { externalId } : {}),
			...(accountHint ? { accountHint } : {}),
			raw: row.raw,
		};
	});
	const hints = new Set(rows.map((row) => row.accountHint).filter(Boolean));
	return {
		format: options.format ?? "csv",
		presetId: preset.id,
		presetLabel: preset.label,
		rows,
		errors: errors.slice(0, 50),
		skipped,
		signConvention: sign,
		accountHint: hints.size === 1 ? ([...hints][0] ?? null) : null,
		currency: dominantCurrency(rows) ?? fallbackCurrency,
	};
}

function dominantCurrency(rows: StatementRow[]) {
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/* ───────────────────────── OFX / QFX ───────────────────────── */

export function looksLikeOfx(text: string) {
	const head = text.slice(0, 4000);
	return /OFXHEADER\s*[:=]/i.test(head) || /<OFX>/i.test(text.slice(0, 20000));
}

export function looksLikeQif(text: string) {
	return /^\s*!(Type|Account|Option|Clear)[:\s]/i.test(text.slice(0, 500));
}

function decodeEntities(text: string) {
	return text
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&amp;/gi, "&");
}

/** Leaf value in an SGML/XML OFX fragment (`<NAME>value` with or without `</NAME>`). */
function ofxTag(block: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i").exec(block);
	const value = match?.[1]?.trim();
	return value ? decodeEntities(value) : undefined;
}

/** "20261003120000.000[-5:EST]" → "2026-10-03". */
export function ofxDate(value: string | undefined): string | undefined {
	const match = /^(\d{4})(\d{2})(\d{2})/.exec(value?.trim() ?? "");
	if (!match) return undefined;
	return parseDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function decimalToMinor(text: string | undefined, currency: string) {
	if (!text) return undefined;
	const trimmed = text.trim();
	const negative = /^-/.test(trimmed);
	const decimal = parseDecimalString(
		trimmed.replace(/^[-+]/, ""),
		minorDigits(currency),
	);
	if (decimal === undefined) return undefined;
	const minor = parseMoney(decimal, { currency })?.amountMinor;
	if (minor === undefined) return undefined;
	return negative ? -minor : minor;
}

const OFX_TYPE_KIND: Record<string, TransactionKind | undefined> = {
	PAYMENT: "payment",
	FEE: "fee",
	SRVCHG: "fee",
	INT: "fee",
	XFER: "other",
};

export function parseOfx(
	text: string,
	options: StatementParseOptions = {},
): StatementParseResult {
	const rows: StatementRow[] = [];
	const errors: StatementParseResult["errors"] = [];
	const body = text.slice(Math.max(0, text.search(/<OFX>/i)));
	// Each statement response carries its account + currency.
	const statements = body.split(/<(?:CC)?STMTRS>/i).slice(1);
	const blocks = statements.length ? statements : [body];
	let accountHint: string | null = null;
	let fileCurrency = normalizeCurrencyCode(options.currency) ?? undefined;
	for (const statement of blocks) {
		const currency =
			normalizeCurrencyCode(ofxTag(statement, "CURDEF")) ??
			fileCurrency ??
			"USD";
		fileCurrency ??= currency;
		const account = last4(ofxTag(statement, "ACCTID"));
		if (account) accountHint ??= account;
		const transactions = statement.split(/<STMTTRN>/i).slice(1);
		transactions.forEach((chunk, index) => {
			const block = chunk.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0] ?? chunk;
			const date =
				ofxDate(ofxTag(block, "DTUSER")) ?? ofxDate(ofxTag(block, "DTPOSTED"));
			const signed = decimalToMinor(ofxTag(block, "TRNAMT"), currency);
			const name = ofxTag(block, "NAME") ?? ofxTag(block, "PAYEE");
			const memo = ofxTag(block, "MEMO");
			const description =
				name && memo && name.length < 12 && !memo.startsWith(name)
					? `${name} ${memo}`
					: (name ?? memo);
			if (!date || signed === undefined || !description) {
				errors.push({
					row: index + 1,
					message: `Transaction ${index + 1}: missing ${!date ? "date" : signed === undefined ? "amount" : "name"}`,
				});
				return;
			}
			// OFX: negative TRNAMT = money leaving the account (a charge).
			const amountMinor = -signed;
			const trnType = (ofxTag(block, "TRNTYPE") ?? "").toUpperCase();
			const raw: Record<string, string> = {};
			for (const tag of [
				"TRNTYPE",
				"DTPOSTED",
				"DTUSER",
				"TRNAMT",
				"FITID",
				"NAME",
				"MEMO",
				"CHECKNUM",
				"SIC",
				"CURSYM",
				"CURRATE",
			]) {
				const value = ofxTag(block, tag);
				if (value) raw[tag] = value;
			}
			const fitid = ofxTag(block, "FITID");
			rows.push({
				date,
				description,
				amountMinor,
				currency,
				kind:
					OFX_TYPE_KIND[trnType] ?? classifyKind(amountMinor, description, ""),
				...(fitid ? { externalId: fitid } : {}),
				...(account ? { accountHint: account } : {}),
				raw,
			});
		});
	}
	return {
		format: "ofx",
		presetId: "ofx",
		presetLabel: "OFX / QFX",
		rows,
		errors: errors.slice(0, 50),
		skipped: 0,
		signConvention: null,
		accountHint,
		currency: fileCurrency ?? "USD",
	};
}

/* ───────────────────────── QIF ───────────────────────── */

/** QIF dates: "10/3/26", "10/ 3'26", "10/03/2026", "3.10.2026" (day first). */
export function qifDate(text: string, dayFirst = false): string | undefined {
	const cleaned = text.replace(/\s+/g, "").replace(/'/g, "/");
	const match = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(cleaned);
	if (!match) return parseDate(text, { dayFirst });
	const [a, b, c] = [Number(match[1]), Number(match[2]), match[3] ?? ""];
	if (String(match[1]).length === 4) return parseDate(`${a}-${b}-${c}`);
	let year = Number(c);
	if (c.length <= 2) year += year < 70 ? 2000 : 1900;
	const dot = cleaned.includes(".");
	const [month, day] = dayFirst || dot ? [b, a] : [a, b];
	return parseDate(
		`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
	);
}

export function parseQif(
	text: string,
	options: StatementParseOptions = {},
): StatementParseResult {
	const currency = normalizeCurrencyCode(options.currency) ?? "USD";
	const rows: StatementRow[] = [];
	const errors: StatementParseResult["errors"] = [];
	let section = "";
	let record: Record<string, string> = {};
	let recordIndex = 0;
	let accountHint: string | null = null;
	const flush = () => {
		if (!Object.keys(record).length) return;
		recordIndex++;
		if (/^account/i.test(section)) {
			accountHint ??= last4(record.N) ?? null;
		} else if (
			!/^(type:(cat|class|memorized|invitem|template)|option)/i.test(section)
		) {
			const date = record.D ? qifDate(record.D, options.dayFirst) : undefined;
			const signed = decimalToMinor(record.T ?? record.U, currency);
			const description = record.P || record.M || "";
			if (!date || signed === undefined || !description) {
				errors.push({
					row: recordIndex,
					message: `Record ${recordIndex}: missing ${!date ? "date" : signed === undefined ? "amount" : "payee"}`,
				});
			} else {
				// QIF: negative T = money out (a charge) for bank and card accounts.
				const amountMinor = -signed;
				rows.push({
					date,
					description,
					amountMinor,
					currency,
					kind: classifyKind(amountMinor, description, record.L ?? ""),
					raw: { ...record },
				});
			}
		}
		record = {};
	};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/^﻿/, "");
		if (!line.trim()) continue;
		if (line.startsWith("!")) {
			flush();
			section = line.slice(1).trim();
			continue;
		}
		if (line.startsWith("^")) {
			flush();
			continue;
		}
		const code = line[0] ?? "";
		const value = line.slice(1).trim();
		// Split lines (S/E/$) repeat; keep the first of each.
		if (code && record[code] === undefined) record[code] = value;
	}
	flush();
	return {
		format: "qif",
		presetId: "qif",
		presetLabel: "QIF",
		rows,
		errors: errors.slice(0, 50),
		skipped: 0,
		signConvention: null,
		accountHint,
		currency,
	};
}

/* ───────────────────────── identity ───────────────────────── */

/**
 * Identity strings for deduplication. A bank id (FITID) wins; otherwise
 * date + amount + currency + description + occurrence number within the file,
 * so two identical coffees on one day stay two rows while a re-import of the
 * same file (or an overlapping statement) maps onto the same identities.
 */
export function transactionIdentities(
	rows: StatementRow[],
	accountKey: string,
): string[] {
	const seen = new Map<string, number>();
	return rows.map((row) => {
		if (row.externalId) return `id|${accountKey}|${row.externalId}`;
		const base = [
			accountKey,
			row.date,
			row.amountMinor,
			row.currency,
			row.description.toLowerCase().replace(/\s+/g, " ").trim(),
		].join("|");
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return `row|${base}|${count}`;
	});
}
