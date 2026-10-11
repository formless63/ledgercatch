/**
 * Word-box layout of an uploaded document (PDF text layer or OCR), stored on
 * the capture as body_json. Pure and client-safe: the review UI uses the same
 * helpers to map selections back to text.
 *
 * Coordinates are page units with a top-left origin: PDF points (viewport at
 * scale 1) for PDFs, pixels for images. The UI scales by width/height.
 */

export type BBox = [number, number, number, number];

export type LayoutWord = {
	text: string;
	bbox: BBox;
	/** OCR confidence 0–100 (absent for PDF text). */
	conf?: number;
};

export type LayoutPage = {
	width: number;
	height: number;
	words: LayoutWord[];
	/** How this page's words were produced. */
	source?: "pdf-text" | "tesseract" | "text";
};

export type OcrSource = "pdf-text" | "tesseract" | "paperless" | "mixed";

export type DocumentLayout = {
	pages: LayoutPage[];
	ocrSource: OcrSource;
	/**
	 * True when the layout was synthesized from plain text (e.g. Paperless
	 * OCR text without geometry): word boxes are not positions on the page.
	 */
	synthetic?: boolean;
};

export type WordRef = { page: number; index: number };

export type LayoutLine = {
	page: number;
	refs: WordRef[];
	words: LayoutWord[];
	/** Words joined by single spaces. */
	text: string;
	/** Start offset of each word within `text`. */
	offsets: number[];
	bbox: BBox;
	/** Median word height. */
	height: number;
};

const MAX_PAGES = 20;

/** Validates an unknown body_json value as a layout (null when absent). */
export function readLayout(value: unknown): DocumentLayout | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as { pages?: unknown; ocrSource?: unknown };
	if (!Array.isArray(raw.pages)) return null;
	const pages: LayoutPage[] = [];
	for (const page of raw.pages.slice(0, MAX_PAGES)) {
		if (!page || typeof page !== "object") continue;
		const p = page as Partial<LayoutPage>;
		if (typeof p.width !== "number" || typeof p.height !== "number") continue;
		const words = Array.isArray(p.words)
			? p.words.filter(
					(w): w is LayoutWord =>
						!!w &&
						typeof w.text === "string" &&
						Array.isArray(w.bbox) &&
						w.bbox.length === 4 &&
						w.bbox.every((n) => typeof n === "number"),
				)
			: [];
		pages.push({ width: p.width, height: p.height, words, source: p.source });
	}
	const ocrSource =
		raw.ocrSource === "pdf-text" ||
		raw.ocrSource === "tesseract" ||
		raw.ocrSource === "paperless" ||
		raw.ocrSource === "mixed"
			? raw.ocrSource
			: "pdf-text";
	return {
		pages,
		ocrSource,
		synthetic: (value as { synthetic?: unknown }).synthetic === true,
	};
}

/**
 * A layout without geometry built from plain text, one row per line, so the
 * text heuristics still run (Paperless / email OCR text).
 */
export function layoutFromText(
	text: string,
	ocrSource: OcrSource = "paperless",
): DocumentLayout {
	const lines = text.split(/\r?\n/).slice(0, 4000);
	const words: LayoutWord[] = [];
	const lineHeight = 12;
	let width = 600;
	lines.forEach((line, row) => {
		let x = 0;
		for (const token of line.split(/\s+/)) {
			if (!token) {
				x += 6;
				continue;
			}
			const w = token.length * 6;
			words.push({
				text: token,
				bbox: [x, row * lineHeight, x + w, row * lineHeight + 10],
			});
			x += w + 6;
		}
		width = Math.max(width, x);
	});
	return {
		pages: [
			{
				width,
				height: Math.max(lines.length * lineHeight, 100),
				words,
				source: "text",
			},
		],
		ocrSource,
		synthetic: true,
	};
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Groups words into reading-order rows (by vertical overlap) per page. */
export function buildLines(layout: DocumentLayout): LayoutLine[] {
	const lines: LayoutLine[] = [];
	layout.pages.forEach((page, pageIndex) => {
		const indices = page.words
			.map((word, index) => ({ word, index }))
			.filter(({ word }) => word.text.trim().length > 0)
			.sort(
				(a, b) =>
					(a.word.bbox[1] + a.word.bbox[3]) / 2 -
					(b.word.bbox[1] + b.word.bbox[3]) / 2,
			);
		let current: Array<{ word: LayoutWord; index: number }> = [];
		let centerSum = 0;
		let heightSum = 0;
		const flush = () => {
			if (current.length === 0) return;
			current.sort((a, b) => a.word.bbox[0] - b.word.bbox[0]);
			let text = "";
			const offsets: number[] = [];
			for (const { word } of current) {
				if (text) text += " ";
				offsets.push(text.length);
				text += word.text;
			}
			const words = current.map((c) => c.word);
			lines.push({
				page: pageIndex,
				refs: current.map((c) => ({ page: pageIndex, index: c.index })),
				words,
				text,
				offsets,
				bbox: [
					Math.min(...words.map((w) => w.bbox[0])),
					Math.min(...words.map((w) => w.bbox[1])),
					Math.max(...words.map((w) => w.bbox[2])),
					Math.max(...words.map((w) => w.bbox[3])),
				],
				height: median(words.map((w) => w.bbox[3] - w.bbox[1])),
			});
			current = [];
			centerSum = 0;
			heightSum = 0;
		};
		for (const entry of indices) {
			const center = (entry.word.bbox[1] + entry.word.bbox[3]) / 2;
			const height = Math.max(1, entry.word.bbox[3] - entry.word.bbox[1]);
			if (current.length > 0) {
				const avgCenter = centerSum / current.length;
				const avgHeight = heightSum / current.length;
				if (Math.abs(center - avgCenter) > 0.5 * Math.min(avgHeight, height))
					flush();
			}
			current.push(entry);
			centerSum += center;
			heightSum += height;
		}
		flush();
	});
	return lines;
}

/** Word refs of a line overlapping the character range [start, end). */
export function refsInRange(
	line: LayoutLine,
	start: number,
	end: number,
): WordRef[] {
	const refs: WordRef[] = [];
	line.words.forEach((word, i) => {
		const ws = line.offsets[i] ?? 0;
		const we = ws + word.text.length;
		if (ws < end && we > start) {
			const ref = line.refs[i];
			if (ref) refs.push(ref);
		}
	});
	return refs;
}

export function wordAt(
	layout: DocumentLayout,
	ref: WordRef,
): LayoutWord | undefined {
	return layout.pages[ref.page]?.words[ref.index];
}

/** Text of the referenced words in reading order (rows top→bottom, left→right). */
export function textOfRefs(layout: DocumentLayout, refs: WordRef[]): string {
	const words = refs
		.map((ref) => ({ ref, word: wordAt(layout, ref) }))
		.filter((x): x is { ref: WordRef; word: LayoutWord } => !!x.word);
	words.sort((a, b) => {
		if (a.ref.page !== b.ref.page) return a.ref.page - b.ref.page;
		const ha = a.word.bbox[3] - a.word.bbox[1];
		const dy =
			(a.word.bbox[1] + a.word.bbox[3]) / 2 -
			(b.word.bbox[1] + b.word.bbox[3]) / 2;
		if (Math.abs(dy) > ha * 0.5) return dy;
		return a.word.bbox[0] - b.word.bbox[0];
	});
	return words.map((w) => w.word.text).join(" ");
}

/** Union bbox of refs on one page (null when refs span no words). */
export function unionBox(
	layout: DocumentLayout,
	refs: WordRef[],
): { page: number; bbox: BBox } | null {
	const first = refs[0];
	if (!first) return null;
	const words = refs
		.filter((r) => r.page === first.page)
		.map((r) => wordAt(layout, r))
		.filter((w): w is LayoutWord => !!w);
	if (words.length === 0) return null;
	return {
		page: first.page,
		bbox: [
			Math.min(...words.map((w) => w.bbox[0])),
			Math.min(...words.map((w) => w.bbox[1])),
			Math.max(...words.map((w) => w.bbox[2])),
			Math.max(...words.map((w) => w.bbox[3])),
		],
	};
}

/** Word refs whose centers fall inside a rectangle on a page. */
export function refsInRect(
	layout: DocumentLayout,
	page: number,
	rect: BBox,
): WordRef[] {
	const p = layout.pages[page];
	if (!p) return [];
	const refs: WordRef[] = [];
	p.words.forEach((word, index) => {
		const cx = (word.bbox[0] + word.bbox[2]) / 2;
		const cy = (word.bbox[1] + word.bbox[3]) / 2;
		const overlapsX = word.bbox[0] < rect[2] && word.bbox[2] > rect[0];
		const overlapsY = word.bbox[1] < rect[3] && word.bbox[3] > rect[1];
		const centerInside =
			cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3];
		if (centerInside || (overlapsX && overlapsY && rect[2] - rect[0] < 2))
			refs.push({ page, index });
	});
	return refs;
}

export function plainText(layout: DocumentLayout): string {
	return buildLines(layout)
		.map((line) => line.text)
		.join("\n");
}

export const refKey = (ref: WordRef) => `${ref.page}:${ref.index}`;
