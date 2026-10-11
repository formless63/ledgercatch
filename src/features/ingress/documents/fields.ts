/**
 * Field extraction from a document layout: label proximity (same row to the
 * right, or directly below), largest top-of-page text for the merchant, and
 * aligned-column detection for line items. Pure and client-safe so the review
 * UI parses selections with the same rules.
 */
import { parseDate } from "#/features/parsing/dates";
import {
	detectCurrency,
	minorDigits,
	normalizeCurrencyCode,
	parseMoney,
} from "#/features/parsing/money";
import { extractLast4 } from "#/features/parsing/text";
import type { ParsedItem, ParsedOrder } from "#/features/parsing/types";
import {
	type BBox,
	buildLines,
	type DocumentLayout,
	type LayoutLine,
	refsInRange,
	refsInRect,
	textOfRefs,
	type WordRef,
} from "./layout";

export const FIELD_KEYS = [
	"merchantName",
	"externalOrderId",
	"orderDate",
	"currency",
	"subtotal",
	"shipping",
	"tax",
	"discount",
	"total",
	"paymentLast4",
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const MONEY_FIELDS = [
	"subtotal",
	"shipping",
	"tax",
	"discount",
	"total",
] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];

export type FieldVia = "label" | "position" | "template" | "ai" | "text";

export type FieldGuess = {
	/** Normalized value: money as decimal string, dates ISO, text trimmed. */
	value: string;
	/** 0–1. */
	confidence: number;
	refs: WordRef[];
	via: FieldVia;
};

export type ItemGuess = {
	title: string;
	quantity: string;
	unitPrice?: string;
	total?: string;
	refs: WordRef[];
};

export type DocumentExtraction = {
	version: 1;
	fields: Partial<Record<FieldKey, FieldGuess>>;
	items: ItemGuess[];
	aiUsed: boolean;
	templateId?: string;
	warnings: string[];
};

/* ───────────────────────── value parsing ───────────────────────── */

export function minorToDecimal(minor: number, currency?: string): string {
	const digits = minorDigits(currency);
	const sign = minor < 0 ? "-" : "";
	return `${sign}${(Math.abs(minor) / 10 ** digits).toFixed(digits)}`;
}

export function decimalToMinor(
	value: string | undefined,
	currency?: string,
): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = parseMoney(value.trim(), { currency: currency ?? "USD" });
	return parsed?.amountMinor;
}

export type MoneyHit = {
	start: number;
	end: number;
	minor: number;
	currency?: string;
	/** Has an explicit currency symbol/code next to it. */
	marked: boolean;
};

const NUMBER_RE =
	/\d{1,3}(?:[ ,.'  ]\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?/g;
const SYMBOL_BEFORE_RE =
	/(?:\b(?:US|CA|C|AU|A|NZ|HK|S|NT|MX|R|CN)\s?\$|[$€£¥￥₹₩₽₺₪฿₱]|\b[A-Z]{3}\b)\s?$/;
const SYMBOL_AFTER_RE = /^\s?(?:€|zł|kr\b|Kč|£|\$|\b[A-Z]{3}\b)/;

/**
 * Money amounts in free text with their character ranges. A bare number only
 * counts when it has a 2-digit (or 3 for KWD-like) fraction; integers need a
 * currency marker. Percentages and dates are skipped.
 */
export function findMoney(text: string, currencyHint?: string): MoneyHit[] {
	const hits: MoneyHit[] = [];
	for (const m of text.matchAll(NUMBER_RE)) {
		const raw = m[0];
		let start = m.index ?? 0;
		let end = start + raw.length;
		const prevChar = text[start - 1] ?? "";
		const nextChars = text.slice(end, end + 2);
		if (/[\dA-Za-z/:]/.test(prevChar) && !/[$€£¥₹]/.test(prevChar)) {
			// "INV-1001", "A12.50", "10/03": part of another token.
			if (
				/[A-Za-z]/.test(prevChar) &&
				!/(?:US|CA|AU|NZ|HK|R|[A-Z]{3})$/.test(text.slice(0, start))
			)
				continue;
			if (/[\d/:]/.test(prevChar)) continue;
		}
		if (/^[/:]\d|^-\d/.test(nextChars)) continue;
		if (/^\s?%/.test(nextChars)) continue;
		if (/^[.,]\d/.test(nextChars)) continue;
		const before = text.slice(Math.max(0, start - 6), start);
		const after = text.slice(end, end + 5);
		const symBefore = SYMBOL_BEFORE_RE.exec(before);
		const symAfter = SYMBOL_AFTER_RE.exec(after);
		const marked = Boolean(symBefore || symAfter);
		const hasFraction =
			/[.,]\d{2,3}$/.test(raw) && !/[.,]\d{3}$/.test(raw)
				? true
				: /[.,]\d{3}$/.test(raw) &&
					minorDigits(normalizeCurrencyCode(currencyHint)) === 3;
		if (!marked && !hasFraction) continue;
		if (symBefore) start -= symBefore[0].length;
		if (symAfter) end += symAfter[0].length;
		// Negative: "-$5.00", "($5.00)", "−5,00 €".
		const lead = text.slice(Math.max(0, start - 2), start);
		const negative =
			/[-−]\s?$/.test(lead) ||
			(/\(\s?$/.test(lead) && /^\s?\)/.test(text.slice(end, end + 2)));
		const snippet = text.slice(start, end);
		const parsed = parseMoney(snippet, { currency: currencyHint });
		if (!parsed) continue;
		const amount = Math.abs(parsed.amountMinor);
		hits.push({
			start: negative ? start - (/\s$/.test(lead) ? 2 : 1) : start,
			end,
			minor: negative ? -amount : amount,
			currency: symBefore || symAfter ? parsed.currency : undefined,
			marked,
		});
	}
	return hits;
}

function cleanOrderToken(token: string): string | undefined {
	const t = token.replace(/^[#:№]+/, "").replace(/[.,;:)]+$/, "");
	if (t.length < 3 || t.length > 40) return undefined;
	if (!/\d/.test(t)) return undefined;
	if (!/^[A-Z0-9][A-Z0-9\-/_.]*$/i.test(t)) return undefined;
	if (parseDate(t) && /[/.-]/.test(t)) return undefined;
	return t;
}

/**
 * Parses text selected on the document (or typed) for one field. Returns the
 * normalized value or undefined when it cannot be read.
 */
export function parseFieldValue(
	key: FieldKey,
	text: string,
	options: { currency?: string; dayFirst?: boolean } = {},
): string | undefined {
	const value = text.replace(/\s+/g, " ").trim();
	if (!value) return undefined;
	switch (key) {
		case "subtotal":
		case "shipping":
		case "tax":
		case "discount":
		case "total": {
			if (key === "shipping" && /\b(free|gratis|kostenlos)\b/i.test(value))
				return minorToDecimal(0, options.currency);
			const hits = findMoney(value, options.currency);
			const hit =
				hits[hits.length - 1] ??
				(() => {
					const parsed = parseMoney(value, { currency: options.currency });
					return parsed
						? { minor: parsed.amountMinor, currency: parsed.currency }
						: undefined;
				})();
			if (!hit) return undefined;
			const minor = key === "discount" ? Math.abs(hit.minor) : hit.minor;
			return minorToDecimal(minor, hit.currency ?? options.currency);
		}
		case "orderDate":
			return parseDate(value, { dayFirst: options.dayFirst });
		case "externalOrderId": {
			const tokens = value.split(" ").map(cleanOrderToken);
			const withDigits = tokens.filter((t): t is string => !!t);
			if (withDigits.length) return withDigits[withDigits.length - 1];
			return value.replace(/^#/, "").slice(0, 120) || undefined;
		}
		case "paymentLast4":
			return extractLast4(value) ?? /(\d{4})\D*$/.exec(value)?.[1];
		case "currency":
			return detectCurrency(value) ?? normalizeCurrencyCode(value);
		case "merchantName":
			return value.replace(/^[\W_]+|[\W_]+$/gu, "").slice(0, 200) || undefined;
	}
}

/* ───────────────────────── label proximity ───────────────────────── */

type Label = { re: RegExp; score: number };

/** Exported for tests and for the UI's label hints. */
export const MONEY_LABELS: Record<MoneyField, Label[]> = {
	total: [
		{
			re: /\b(?:grand\s+total|order\s+total|invoice\s+total|total\s+(?:amount\s+)?(?:due|paid|charged)|amount\s+(?:due|paid|charged)|balance\s+due|total\s+(?:incl\.?|including|inc\.?)\s*(?:tax|vat|gst)?|gesamtbetrag|rechnungsbetrag|endbetrag|total\s+ttc)\b/i,
			score: 1,
		},
		{
			re: /\b(?:total|summe|gesamt)\b(?!\s*(?:tax|vat|gst|shipping|discount|savings|before|excl|items?\b|qty|quantity|weight|net|pieces|units))/i,
			score: 0.75,
		},
	],
	subtotal: [
		{
			re: /\b(?:sub[\s-]?total|items?\s+subtotal|merchandise(?:\s+total)?|net\s+(?:amount|total)|total\s+(?:before|excl\.?|excluding)\s+(?:tax|vat)|zwischensumme|nettobetrag|warenwert)\b/i,
			score: 0.95,
		},
	],
	tax: [
		{
			re: /(?<!(?:incl\.?|including|inc\.?|excl\.?|excluding)\s{0,2})\b(?:sales\s+tax|estimated\s+tax|total\s+tax|tax(?:es)?|vat|gst|hst|pst|qst|mwst\.?|ust\.?|iva|tva)\b(?!\s*(?:id|no\b|no\.|number|reg|registration|#|exempt|invoice))/i,
			score: 0.9,
		},
	],
	shipping: [
		{
			re: /\b(?:shipping(?:\s*(?:&|and)\s*handling)?|delivery(?:\s+(?:fee|charge|cost))?|freight|postage|s\s?&\s?h|versand(?:kosten)?|porto)\b(?!\s*(?:address|addr|to\b|method|via|info|details|options?|speed|date|carrier|label|from))/i,
			score: 0.9,
		},
	],
	discount: [
		{
			re: /\b(?:discount|coupon|promo(?:tion)?(?:\s+code)?|savings|you\s+saved|rabatt|gutschein)\b/i,
			score: 0.85,
		},
	],
};

const ORDER_LABEL_RE =
	/\b(order|invoice|receipt|confirmation|reference|ref\.?|purchase\s+order|po|bestell|bestellung|rechnung|auftrag)(?:\s*-?\s*(#|no\.?|nr\.?|number|num\.?|id|nummer|code))?\s*[:#]?/gi;
const ORDER_LABEL_SCORES: Record<string, number> = {
	order: 0.9,
	bestell: 0.9,
	bestellung: 0.9,
	auftrag: 0.8,
	invoice: 0.85,
	rechnung: 0.85,
	receipt: 0.8,
	confirmation: 0.8,
	"purchase order": 0.6,
	po: 0.5,
	reference: 0.6,
	ref: 0.55,
	"ref.": 0.55,
};

const DATE_LABEL_RE =
	/(?<!(?:due|ship(?:ping|ped)?|delivery|deliver(?:ed)?|expiry|expiration|valid|start|end|period)\s{0,2})\b(?:(order(?:ed)?\s+(?:date|on|placed)|invoice\s+date|date\s+(?:of\s+)?(?:order|invoice|issue|purchase)|purchase(?:d)?\s+(?:date|on)|placed\s+on|issue\s+date|issued(?:\s+on)?|receipt\s+date|transaction\s+date|billing\s+date|rechnungsdatum|bestelldatum|belegdatum)|(datum|date))\b\s*:?/gi;

type Candidate = {
	value: string;
	refs: WordRef[];
	score: number;
	position?: number;
};

/** Lines directly below `line` (same page) within a few line heights. */
function linesBelow(
	lines: LayoutLine[],
	lineIndex: number,
	labelBox: BBox,
	maxLines = 2,
	capX = Number.POSITIVE_INFINITY,
): Array<{ line: LayoutLine; refs: WordRef[]; text: string }> {
	const base = lines[lineIndex];
	if (!base) return [];
	const out: Array<{ line: LayoutLine; refs: WordRef[]; text: string }> = [];
	const height = Math.max(base.height, 1);
	const labelWidth = labelBox[2] - labelBox[0];
	for (let i = lineIndex + 1; i < lines.length && out.length < maxLines; i++) {
		const line = lines[i];
		if (!line || line.page !== base.page) break;
		if (line.bbox[1] - base.bbox[3] > height * 3) break;
		// Words horizontally under the label (allow drift for right-aligned values).
		const x0 = labelBox[0] - labelWidth * 0.6 - height;
		const x1 = Math.min(labelBox[2] + labelWidth * 1.5 + height * 4, capX);
		const picked: number[] = [];
		line.words.forEach((word, wi) => {
			if (word.bbox[2] > x0 && word.bbox[0] < x1) picked.push(wi);
		});
		if (picked.length === 0) continue;
		const text = picked.map((wi) => line.words[wi]?.text ?? "").join(" ");
		out.push({
			line,
			refs: picked.map((wi) => line.refs[wi]).filter((r): r is WordRef => !!r),
			text,
		});
	}
	return out;
}

function refsForSubstring(
	refs: WordRef[],
	words: string[],
	start: number,
	end: number,
): WordRef[] {
	const out: WordRef[] = [];
	let offset = 0;
	words.forEach((word, i) => {
		const ws = offset;
		const we = ws + word.length;
		offset = we + 1;
		const ref = refs[i];
		if (ref && ws < end && we > start) out.push(ref);
	});
	return out;
}

function labelBox(line: LayoutLine, start: number, end: number): BBox {
	const words = line.words.filter((w, i) => {
		const ws = line.offsets[i] ?? 0;
		return ws < end && ws + w.text.length > start;
	});
	if (words.length === 0) return line.bbox;
	return [
		Math.min(...words.map((w) => w.bbox[0])),
		Math.min(...words.map((w) => w.bbox[1])),
		Math.max(...words.map((w) => w.bbox[2])),
		Math.max(...words.map((w) => w.bbox[3])),
	];
}

/**
 * When the words after a label sit in another column (a big gap), the label
 * is a column header and its value is below. Returns the x where that next
 * column starts (to cap the search), or undefined when the tail is adjacent.
 */
function nextColumnX(
	line: LayoutLine,
	labelEnd: number,
	box: BBox,
): number | undefined {
	const idx = line.offsets.findIndex((o) => o >= labelEnd);
	if (idx < 0) return Number.POSITIVE_INFINITY;
	const word = line.words[idx];
	if (!word) return Number.POSITIVE_INFINITY;
	return word.bbox[0] - box[2] > line.height * 2.5 ? word.bbox[0] : undefined;
}

function moneyCandidates(
	lines: LayoutLine[],
	labels: Label[],
	options: {
		currency?: string;
		allowFree?: boolean;
		pageWidth: (page: number) => number;
		skipLine?: (line: LayoutLine) => boolean;
	},
): Array<Candidate & { minor: number; currency?: string; position: number }> {
	const out: Array<
		Candidate & { minor: number; currency?: string; position: number }
	> = [];
	lines.forEach((line, lineIndex) => {
		if (options.skipLine?.(line)) return;
		for (const label of labels) {
			const re = new RegExp(
				label.re.source,
				label.re.flags.includes("g") ? label.re.flags : `${label.re.flags}g`,
			);
			for (const m of line.text.matchAll(re)) {
				const lStart = m.index ?? 0;
				const lEnd = lStart + m[0].length;
				const box = labelBox(line, lStart, lEnd);
				const tail = line.text.slice(lEnd);
				const maxGap = options.pageWidth(line.page) * 0.55;
				if (
					options.allowFree &&
					/^\s*[:\-–]?\s*(free|gratis|kostenlos)\b/i.test(tail)
				) {
					const fm = /(free|gratis|kostenlos)/i.exec(tail);
					const fs = lEnd + (fm?.index ?? 0);
					out.push({
						value: minorToDecimal(0, options.currency),
						minor: 0,
						refs: refsInRange(line, fs, fs + (fm?.[0].length ?? 4)),
						score: label.score,
						position: lineIndex,
					});
					continue;
				}
				// Stop at the next label on the row ("Subtotal $5  Tax: $1").
				const nextLabel = /[A-Za-z]{3,}[^:$€£\d]*:/.exec(tail);
				const tailHits = findMoney(tail, options.currency).filter(
					(hit) => !nextLabel || hit.start < nextLabel.index,
				);
				const hit = tailHits[0];
				if (hit) {
					const refs = refsInRange(line, lEnd + hit.start, lEnd + hit.end);
					const firstRefWord = refs[0]
						? line.words[line.refs.indexOf(refs[0])]
						: undefined;
					const gap = firstRefWord ? firstRefWord.bbox[0] - box[2] : 0;
					if (gap <= maxGap) {
						out.push({
							value: minorToDecimal(
								hit.minor,
								hit.currency ?? options.currency,
							),
							minor: hit.minor,
							currency: hit.currency,
							refs,
							score: label.score,
							position: lineIndex,
						});
						continue;
					}
				}
				const capX = nextColumnX(line, lEnd, box);
				if (capX === undefined) continue;
				for (const below of linesBelow(lines, lineIndex, box, 1, capX)) {
					const belowHit = findMoney(below.text, options.currency)[0];
					if (!belowHit) continue;
					out.push({
						value: minorToDecimal(
							belowHit.minor,
							belowHit.currency ?? options.currency,
						),
						minor: belowHit.minor,
						currency: belowHit.currency,
						refs: refsForSubstring(
							below.refs,
							below.text.split(" "),
							belowHit.start,
							belowHit.end,
						),
						score: label.score * 0.85,
						position: lineIndex,
					});
					break;
				}
			}
		}
	});
	return out;
}

function orderNumberCandidates(lines: LayoutLine[]): Candidate[] {
	const out: Candidate[] = [];
	lines.forEach((line, lineIndex) => {
		for (const m of line.text.matchAll(ORDER_LABEL_RE)) {
			const word = (m[1] ?? "").toLowerCase().replace(/\s+/g, " ");
			const qualified = Boolean(m[2]) || /#\s*$|:\s*$/.test(m[0]);
			const base = ORDER_LABEL_SCORES[word] ?? 0.5;
			const lStart = m.index ?? 0;
			const lEnd = lStart + m[0].length;
			const tail = line.text.slice(lEnd);
			const tokens = tail
				.split(" ")
				.filter(Boolean)
				.slice(0, qualified ? 3 : 1);
			let offset = lEnd + (tail.length - tail.trimStart().length);
			let found = false;
			for (const token of tokens) {
				const cleaned = cleanOrderToken(token);
				if (cleaned) {
					out.push({
						value: cleaned,
						refs: refsInRange(line, offset, offset + token.length),
						score: qualified ? base : base * 0.8,
						position: lineIndex,
					});
					found = true;
					break;
				}
				// A new label ("Date:") ends the search.
				if (/[A-Za-z]{2,}:$/.test(token)) break;
				offset += token.length + 1;
			}
			if (found || !qualified) continue;
			const box = labelBox(line, lStart, lEnd);
			const capX = nextColumnX(line, lEnd, box);
			if (capX === undefined) continue;
			for (const below of linesBelow(lines, lineIndex, box, 1, capX)) {
				const tokensBelow = below.text.split(" ");
				const idx = tokensBelow.findIndex((t) => cleanOrderToken(t));
				const cleaned =
					idx >= 0 ? cleanOrderToken(tokensBelow[idx] ?? "") : undefined;
				const ref = idx >= 0 ? below.refs[idx] : undefined;
				if (cleaned && ref) {
					out.push({ value: cleaned, refs: [ref], score: base * 0.85 });
					break;
				}
			}
		}
	});
	return out;
}

function dateFromWords(
	words: string[],
	options: { dayFirst?: boolean },
): { value: string; start: number; count: number } | undefined {
	for (let i = 0; i < Math.min(words.length, 6); i++) {
		for (let len = 1; len <= 4 && i + len <= words.length; len++) {
			const value = parseDate(words.slice(i, i + len).join(" "), options);
			if (value) {
				// Prefer the longest window that still parses to the same date
				// ("Oct 3, 2026" over "Oct 3,").
				let count = len;
				for (let more = len + 1; more <= 4 && i + more <= words.length; more++)
					if (parseDate(words.slice(i, i + more).join(" "), options) === value)
						count = more;
					else break;
				return { value, start: i, count };
			}
		}
	}
	return undefined;
}

function dateCandidates(
	lines: LayoutLine[],
	options: { dayFirst?: boolean },
): Candidate[] {
	const out: Candidate[] = [];
	lines.forEach((line, lineIndex) => {
		for (const m of line.text.matchAll(DATE_LABEL_RE)) {
			const specific = Boolean(m[1]);
			const score = specific ? 0.9 : 0.65;
			const lStart = m.index ?? 0;
			const lEnd = lStart + m[0].length;
			const tail = line.text.slice(lEnd).trim();
			const tailOffset =
				line.text.length - line.text.slice(lEnd).trimStart().length;
			const tailWords = tail ? tail.split(" ") : [];
			const hit = dateFromWords(tailWords, options);
			if (hit && hit.start <= 2) {
				let off = tailOffset;
				for (let k = 0; k < hit.start; k++)
					off += (tailWords[k]?.length ?? 0) + 1;
				const text = tailWords
					.slice(hit.start, hit.start + hit.count)
					.join(" ");
				out.push({
					value: hit.value,
					refs: refsInRange(line, off, off + text.length),
					score,
				});
				continue;
			}
			const box = labelBox(line, lStart, lEnd);
			const capX = nextColumnX(line, lEnd, box);
			if (capX === undefined) continue;
			for (const below of linesBelow(lines, lineIndex, box, 1, capX)) {
				const words = below.text.split(" ");
				const bh = dateFromWords(words, options);
				if (!bh) continue;
				out.push({
					value: bh.value,
					refs: below.refs.slice(bh.start, bh.start + bh.count),
					score: score * 0.85,
				});
				break;
			}
		}
	});
	return out;
}

const MERCHANT_STOP_RE =
	/^(?:tax\s+)?(?:invoice|receipt|order|order\s+confirmation|confirmation|statement|packing\s+slip|bill(?:ed)?\s+to|ship(?:ped)?\s+to|sold\s+to|page\s+\d+|thank\s+you.*|rechnung|quittung|lieferschein|original|copy|paid|bill)\b/i;

function merchantCandidate(
	layout: DocumentLayout,
	lines: LayoutLine[],
): Candidate | undefined {
	const first = layout.pages[0];
	if (!first) return undefined;
	const heights = lines
		.filter((l) => l.page === 0)
		.map((l) => l.height)
		.sort((a, b) => a - b);
	const medianHeight = heights[Math.floor(heights.length / 2)] ?? 1;
	let best:
		| { line: LayoutLine; score: number; refs: WordRef[]; text: string }
		| undefined;
	for (const line of lines) {
		if (line.page !== 0) break;
		if (line.bbox[1] > first.height * 0.3) continue;
		// Use the leading run of words (a header row may also hold "INVOICE").
		const keep: number[] = [];
		line.words.forEach((word, i) => {
			if (MERCHANT_STOP_RE.test(word.text) && keep.length === 0) return;
			const prev = keep.length
				? line.words[keep[keep.length - 1] ?? 0]
				: undefined;
			if (prev && word.bbox[0] - prev.bbox[2] > line.height * 2.5) return;
			if (keep.length && line.words[i - 1] && !keep.includes(i - 1)) return;
			keep.push(i);
		});
		const text = keep
			.map((i) => line.words[i]?.text ?? "")
			.join(" ")
			.trim();
		if (!text || MERCHANT_STOP_RE.test(text)) continue;
		if (!/[A-Za-z]{2,}/.test(text)) continue;
		if (/@|https?:|^www\.|^\+?\d[\d\s()-]{6,}$/.test(text)) continue;
		if (findMoney(text).length || parseDate(text)) continue;
		if (/\d/.test(text) && new RegExp(ORDER_LABEL_RE.source, "i").test(text))
			continue;
		const height =
			keep.reduce((sum, i) => {
				const w = line.words[i];
				return sum + (w ? w.bbox[3] - w.bbox[1] : 0);
			}, 0) / Math.max(1, keep.length);
		const score = height - line.bbox[1] / first.height;
		if (!best || score > best.score)
			best = {
				line,
				score,
				text,
				refs: keep.map((i) => line.refs[i]).filter((r): r is WordRef => !!r),
			};
	}
	if (!best) return undefined;
	const value = parseFieldValue("merchantName", best.text);
	if (!value) return undefined;
	const prominent = best.line.height >= medianHeight * 1.4;
	return { value, refs: best.refs, score: prominent ? 0.6 : 0.4 };
}

/* ───────────────────────── line items ───────────────────────── */

const HEADER_COLUMNS = {
	desc: /^(?:description|item|items|product|products|article|title|name|details|artikel|bezeichnung|beschreibung|leistung)$/i,
	qty: /^(?:qty|quantity|qnty|menge|anz|anzahl|units?|pcs|ordered|shipped)\.?$/i,
	price: /^(?:price|unit|rate|each|preis|einzelpreis|ep)$/i,
	amount:
		/^(?:amount|total|line|subtotal|ext|extended|betrag|gesamt|summe|gp)$/i,
} as const;
type ColumnKey = keyof typeof HEADER_COLUMNS;

type Column = { key: ColumnKey; x0: number; x1: number };

function headerColumns(line: LayoutLine): Column[] | null {
	const cols = new Map<ColumnKey, Column>();
	line.words.forEach((word) => {
		const text = word.text.replace(/[:.]$/, "");
		for (const key of Object.keys(HEADER_COLUMNS) as ColumnKey[]) {
			if (!HEADER_COLUMNS[key].test(text)) continue;
			const existing = cols.get(key);
			// Rightmost amount column ("Total" after "Unit price").
			if (!existing || key === "amount")
				cols.set(key, { key, x0: word.bbox[0], x1: word.bbox[2] });
			break;
		}
	});
	const kinds = [...cols.keys()];
	const numeric = kinds.filter((k) => k !== "desc");
	if (numeric.length === 0) return null;
	if (!cols.has("desc") && numeric.length < 3) return null;
	if (cols.has("desc") && numeric.length < 1) return null;
	if (cols.has("amount") && cols.has("price")) {
		const a = cols.get("amount");
		const p = cols.get("price");
		if (a && p && a.x0 < p.x0) {
			cols.set("amount", { ...p, key: "amount" });
			cols.set("price", { ...a, key: "price" });
		}
	}
	return [...cols.values()].sort((a, b) => a.x0 - b.x0);
}

const STOP_ITEMS_RE =
	/\b(?:sub[\s-]?total|grand\s+total|total|tax|vat|shipping|discount|balance|amount\s+due|zwischensumme|summe)\b/i;

export function extractItems(
	layout: DocumentLayout,
	lines: LayoutLine[] = buildLines(layout),
	currency?: string,
): ItemGuess[] {
	for (let h = 0; h < lines.length; h++) {
		const header = lines[h];
		if (!header) continue;
		const cols = headerColumns(header);
		if (!cols) continue;
		const numericCols = cols.filter((c) => c.key !== "desc");
		const firstNumericX = Math.min(...numericCols.map((c) => c.x0));
		const descCol = cols.find((c) => c.key === "desc");
		const items: ItemGuess[] = [];
		let lastBottom = header.bbox[3];
		for (let i = h + 1; i < lines.length && items.length < 200; i++) {
			const row = lines[i];
			if (!row || row.page !== header.page) break;
			if (row.bbox[1] - lastBottom > Math.max(row.height, header.height) * 4)
				break;
			const descIdx: number[] = [];
			const byCol = new Map<ColumnKey, number[]>();
			row.words.forEach((word, wi) => {
				const cx = (word.bbox[0] + word.bbox[2]) / 2;
				if (
					word.bbox[2] <= firstNumericX + 2 &&
					(!descCol || word.bbox[2] > descCol.x0 - row.height * 8)
				) {
					descIdx.push(wi);
					return;
				}
				let nearest: Column | undefined;
				let dist = Number.POSITIVE_INFINITY;
				for (const col of numericCols) {
					const d = cx < col.x0 ? col.x0 - cx : cx > col.x1 ? cx - col.x1 : 0;
					if (d < dist) {
						dist = d;
						nearest = col;
					}
				}
				if (nearest)
					byCol.set(nearest.key, [...(byCol.get(nearest.key) ?? []), wi]);
			});
			const textOf = (idx: number[] | undefined) =>
				(idx ?? []).map((wi) => row.words[wi]?.text ?? "").join(" ");
			const descText = textOf(descIdx).trim();
			if (
				STOP_ITEMS_RE.test(descText) ||
				(!descText && STOP_ITEMS_RE.test(row.text))
			)
				break;
			const amount = findMoney(textOf(byCol.get("amount")), currency).at(-1);
			const price = findMoney(textOf(byCol.get("price")), currency).at(-1);
			const qtyText = textOf(byCol.get("qty")).trim();
			const qty = /^\d+(?:[.,]\d+)?$/.test(qtyText)
				? qtyText.replace(",", ".")
				: undefined;
			const refs = row.refs;
			if (!amount && !price) {
				const prev = items[items.length - 1];
				if (prev && descText && row.bbox[1] - lastBottom < row.height * 1.5) {
					prev.title = `${prev.title} ${descText}`.slice(0, 500);
					prev.refs = [...prev.refs, ...refs];
					lastBottom = row.bbox[3];
					continue;
				}
				if (items.length) break;
				continue;
			}
			// Rows without a title but with a leading quantity ("2 Widget  $5").
			let title = descText;
			let quantity = qty;
			if (!quantity) {
				const m = /^(\d{1,4})\s*[x×]?\s+(.+)$/.exec(title);
				if (m?.[1] && m[2] && !cols.some((c) => c.key === "qty")) {
					quantity = m[1];
					title = m[2];
				}
			}
			if (!title) continue;
			items.push({
				title: title.slice(0, 500),
				quantity: quantity ?? "1",
				unitPrice: price
					? minorToDecimal(price.minor, price.currency ?? currency)
					: undefined,
				total: amount
					? minorToDecimal(amount.minor, amount.currency ?? currency)
					: undefined,
				refs,
			});
			lastBottom = row.bbox[3];
		}
		if (items.length) return items;
	}
	return [];
}

/* ───────────────────────── assembly ───────────────────────── */

function pickBest<T extends Candidate & { position?: number }>(
	candidates: T[],
	preferLast = false,
): T | undefined {
	let best: T | undefined;
	for (const c of candidates) {
		if (!best || c.score > best.score + 1e-9) best = c;
		else if (
			preferLast &&
			Math.abs(c.score - best.score) < 1e-9 &&
			(c.position ?? 0) >= (best.position ?? 0)
		)
			best = c;
	}
	return best;
}

export type ExtractOptions = {
	/** Currency to assume for bare amounts. */
	currency?: string;
	/** Day-first dates (EU). Default: guessed from the currency. */
	dayFirst?: boolean;
};

/** Heuristic field + line-item extraction from a layout. */
export function extractFields(
	layout: DocumentLayout,
	options: ExtractOptions = {},
): DocumentExtraction {
	const lines = buildLines(layout);
	const fullText = lines.map((l) => l.text).join("\n");
	const detected = detectCurrency(fullText, options.currency);
	const currency = normalizeCurrencyCode(options.currency) ?? detected;
	const dayFirst =
		options.dayFirst ??
		(currency ? !["USD", "CAD", "PHP"].includes(currency) : false);
	const fields: Partial<Record<FieldKey, FieldGuess>> = {};
	const pageWidth = (page: number) => layout.pages[page]?.width ?? 600;

	const itemHeaderLines = new Set(
		lines.filter((line) => headerColumns(line)).map((line) => line),
	);
	const skipLine = (line: LayoutLine) => itemHeaderLines.has(line);

	const money: Partial<
		Record<MoneyField, ReturnType<typeof moneyCandidates>[number]>
	> = {};
	for (const key of MONEY_FIELDS) {
		const candidates = moneyCandidates(lines, MONEY_LABELS[key], {
			currency,
			allowFree: key === "shipping",
			pageWidth,
			skipLine,
		});
		const best = pickBest(candidates, key === "total");
		if (best) money[key] = best;
	}
	// Disambiguate "Total" vs "Subtotal" collisions on the same words.
	if (
		money.total &&
		money.subtotal &&
		money.total.refs.length &&
		money.total.refs.every((r) =>
			money.subtotal?.refs.some(
				(s) => s.page === r.page && s.index === r.index,
			),
		)
	)
		delete money.total;

	// Consistency: subtotal + shipping + tax − discount = total boosts all.
	const sum =
		(money.subtotal?.minor ?? Number.NaN) +
		(money.shipping?.minor ?? 0) +
		(money.tax?.minor ?? 0) -
		Math.abs(money.discount?.minor ?? 0);
	const consistent = money.total && Math.abs(sum - money.total.minor) <= 1;
	for (const key of MONEY_FIELDS) {
		const c = money[key];
		if (!c) continue;
		const value =
			key === "discount"
				? minorToDecimal(Math.abs(c.minor), c.currency ?? currency)
				: c.value;
		fields[key] = {
			value,
			confidence: consistent ? Math.max(c.score, 0.95) : c.score * 0.9,
			refs: c.refs,
			via: "label",
		};
	}

	const order = pickBest(orderNumberCandidates(lines));
	if (order)
		fields.externalOrderId = {
			value: order.value,
			confidence: order.score,
			refs: order.refs,
			via: "label",
		};

	const date = pickBest(dateCandidates(lines, { dayFirst }));
	if (date)
		fields.orderDate = {
			value: date.value,
			confidence: date.score,
			refs: date.refs,
			via: "label",
		};
	else {
		// Fallback: the first absolute date in the top half of page 1.
		for (const line of lines) {
			if (line.page !== 0) break;
			if (line.bbox[1] > (layout.pages[0]?.height ?? 0) / 2) break;
			const words = line.text.split(" ");
			const hit = dateFromWords(words, { dayFirst });
			if (hit) {
				fields.orderDate = {
					value: hit.value,
					confidence: 0.35,
					refs: line.refs.slice(hit.start, hit.start + hit.count),
					via: "position",
				};
				break;
			}
		}
	}

	const merchant = merchantCandidate(layout, lines);
	if (merchant)
		fields.merchantName = {
			value: merchant.value,
			confidence: merchant.score,
			refs: merchant.refs,
			via: "position",
		};

	for (const line of lines) {
		const last4 = extractLast4(line.text);
		if (!last4) continue;
		const idx = line.words.findIndex((w) => w.text.includes(last4));
		const ref = idx >= 0 ? line.refs[idx] : undefined;
		fields.paymentLast4 = {
			value: last4,
			confidence: 0.8,
			refs: ref ? [ref] : [],
			via: "label",
		};
		break;
	}

	const moneyCurrency = MONEY_FIELDS.map((k) => money[k]?.currency).find(
		Boolean,
	);
	const docCurrency = moneyCurrency ?? currency;
	if (docCurrency)
		fields.currency = {
			value: docCurrency,
			confidence: moneyCurrency ? 0.85 : detected ? 0.6 : 0.4,
			refs: [],
			via: "text",
		};

	const items = extractItems(layout, lines, docCurrency);
	const warnings: string[] = [];
	if (!fields.externalOrderId)
		warnings.push("No order or invoice number found");
	if (!fields.total) warnings.push("No total found");
	return { version: 1, fields, items, aiUsed: false, warnings };
}

/* ───────────────────────── value location / templates ───────────────────────── */

function normalizeWithMap(text: string): { norm: string; map: number[] } {
	let norm = "";
	const map: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] ?? "";
		if (/[\p{L}\p{N}]/u.test(ch)) {
			norm += ch.toLowerCase();
			map.push(i);
		}
	}
	return { norm, map };
}

/**
 * Finds word boxes showing `value` (e.g. an AI-extracted value) so the UI can
 * highlight where it came from. Money is matched by amount.
 */
export function locateValue(
	layout: DocumentLayout,
	key: FieldKey,
	value: string,
	lines: LayoutLine[] = buildLines(layout),
	currency?: string,
): WordRef[] {
	if (!value) return [];
	const isMoney = (MONEY_FIELDS as readonly string[]).includes(key);
	const ordered = key === "total" ? [...lines].reverse() : lines;
	if (isMoney) {
		const target = decimalToMinor(value, currency);
		if (target === undefined) return [];
		for (const line of ordered) {
			const hit = findMoney(line.text, currency).find(
				(h) => Math.abs(h.minor) === Math.abs(target),
			);
			if (hit) return refsInRange(line, hit.start, hit.end);
		}
		return [];
	}
	if (key === "orderDate") {
		for (const line of lines) {
			const words = line.text.split(" ");
			for (let i = 0; i < words.length; i++)
				for (let len = 1; len <= 4 && i + len <= words.length; len++)
					if (parseDate(words.slice(i, i + len).join(" ")) === value)
						return line.refs.slice(i, i + len);
		}
		return [];
	}
	const target = normalizeWithMap(value).norm;
	if (target.length < 2) return [];
	for (const line of lines) {
		const { norm, map } = normalizeWithMap(line.text);
		let at = norm.indexOf(target);
		while (at >= 0) {
			const before = norm[at - 1];
			const after = norm[at + target.length];
			const boundaryOk =
				!(/\d/.test(target[0] ?? "") && before && /\d/.test(before)) &&
				!(/\d/.test(target.at(-1) ?? "") && after && /\d/.test(after));
			if (boundaryOk) {
				const start = map[at] ?? 0;
				const end = (map[at + target.length - 1] ?? start) + 1;
				return refsInRange(line, start, end);
			}
			at = norm.indexOf(target, at + 1);
		}
	}
	return [];
}

/** Saved field regions per merchant: relative boxes (0–1) on a page. */
export type TemplateMapping = {
	version: 1;
	merchantName: string;
	fields: Partial<Record<FieldKey, { page: number; box: BBox }>>;
};

export function readTemplateMapping(value: unknown): TemplateMapping | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Partial<TemplateMapping>;
	if (raw.version !== 1 || typeof raw.fields !== "object" || !raw.fields)
		return null;
	return {
		version: 1,
		merchantName: String(raw.merchantName ?? ""),
		fields: raw.fields,
	};
}

/** Builds template regions from the word refs that filled each field. */
export function buildTemplate(
	layout: DocumentLayout,
	merchantName: string,
	refsByField: Partial<Record<FieldKey, WordRef[]>>,
): TemplateMapping {
	const fields: TemplateMapping["fields"] = {};
	for (const key of FIELD_KEYS) {
		const refs = refsByField[key];
		if (!refs?.length || key === "currency") continue;
		const page = refs[0]?.page ?? 0;
		const p = layout.pages[page];
		if (!p) continue;
		const words = refs
			.filter((r) => r.page === page)
			.map((r) => p.words[r.index])
			.filter((w): w is NonNullable<typeof w> => !!w);
		if (!words.length) continue;
		fields[key] = {
			page,
			box: [
				Math.min(...words.map((w) => w.bbox[0])) / p.width,
				Math.min(...words.map((w) => w.bbox[1])) / p.height,
				Math.max(...words.map((w) => w.bbox[2])) / p.width,
				Math.max(...words.map((w) => w.bbox[3])) / p.height,
			],
		};
	}
	return { version: 1, merchantName, fields };
}

/** Reads values from a merchant template's regions (with a little slack). */
export function applyTemplate(
	layout: DocumentLayout,
	template: TemplateMapping,
	options: ExtractOptions = {},
): Partial<Record<FieldKey, FieldGuess>> {
	const out: Partial<Record<FieldKey, FieldGuess>> = {};
	for (const key of FIELD_KEYS) {
		const region = template.fields[key];
		if (!region) continue;
		const page = layout.pages[region.page];
		if (!page) continue;
		const slackX = 0.02;
		const slackY = 0.012;
		const rect: BBox = [
			(region.box[0] - slackX) * page.width,
			(region.box[1] - slackY) * page.height,
			(region.box[2] + slackX) * page.width,
			(region.box[3] + slackY) * page.height,
		];
		const refs = refsInRect(layout, region.page, rect);
		if (!refs.length) continue;
		const value = parseFieldValue(key, textOfRefs(layout, refs), options);
		if (!value) continue;
		out[key] = { value, confidence: 0.8, refs, via: "template" };
	}
	return out;
}

/** Overlays guesses where they beat the current confidence. */
export function mergeGuesses(
	base: Partial<Record<FieldKey, FieldGuess>>,
	extra: Partial<Record<FieldKey, FieldGuess>>,
): Partial<Record<FieldKey, FieldGuess>> {
	const out = { ...base };
	for (const key of FIELD_KEYS) {
		const next = extra[key];
		if (!next) continue;
		const current = out[key];
		if (!current || next.confidence > current.confidence) out[key] = next;
	}
	return out;
}

/* ───────────────────────── order building ───────────────────────── */

/** "ACME Supply Co." → "acme-supply-co": the per-merchant key for generic orders. */
export function merchantSlug(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "merchant";
}

/**
 * Pseudo URL that namespaces generic order numbers by merchant: the ingest
 * step keys generic orders by URL host, so `upload://acme-supply-co/` yields
 * "acme-supply-co:<order #>" for every document from that merchant.
 */
export function merchantOrderUrl(merchantName: string): string {
	return `upload://${merchantSlug(merchantName)}/`;
}

export function isConfidentExtraction(
	extraction: DocumentExtraction,
	options: { knownMerchant?: boolean } = {},
): boolean {
	const f = extraction.fields;
	return Boolean(
		f.externalOrderId &&
			f.externalOrderId.confidence >= 0.7 &&
			f.total &&
			f.total.confidence >= 0.7 &&
			(options.knownMerchant ||
				(f.merchantName && f.merchantName.confidence >= 0.55)),
	);
}

export function extractionToParsedOrder(
	extraction: DocumentExtraction,
	options: { merchantName?: string; orderUrl?: string },
): ParsedOrder | undefined {
	const f = extraction.fields;
	const id = f.externalOrderId?.value;
	if (!id) return undefined;
	const currency = normalizeCurrencyCode(f.currency?.value);
	const minor = (key: MoneyField) => decimalToMinor(f[key]?.value, currency);
	const items: ParsedItem[] = extraction.items.map((item) => {
		const quantity = Number.parseFloat(item.quantity) || 1;
		return {
			title: item.title,
			quantity,
			unitPriceMinor: decimalToMinor(item.unitPrice, currency),
			totalMinor: decimalToMinor(item.total, currency),
		};
	});
	const merchantName = options.merchantName ?? f.merchantName?.value;
	const discount = minor("discount");
	return {
		externalOrderId: id,
		merchantName,
		orderUrl:
			options.orderUrl ??
			(merchantName ? merchantOrderUrl(merchantName) : undefined),
		orderDate: f.orderDate?.value,
		status: "unknown",
		currency,
		subtotalMinor: minor("subtotal"),
		shippingMinor: minor("shipping"),
		taxMinor: minor("tax"),
		discountMinor: discount === undefined ? undefined : Math.abs(discount),
		totalMinor: minor("total"),
		paymentLast4: f.paymentLast4?.value,
		items: items.length ? items : undefined,
	};
}
