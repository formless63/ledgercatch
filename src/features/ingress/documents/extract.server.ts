/**
 * Text + word-box extraction for uploaded documents.
 *
 * PDFs: pdf.js (legacy Node build) text layer → words with boxes in PDF
 * points (top-left origin). Pages without a text layer are rendered with
 * @napi-rs/canvas (pdf.js' Node canvas) and OCR'd. Images are OCR'd directly.
 *
 * pdfjs-dist and tesseract.js are loaded with non-literal specifiers so they
 * stay runtime dependencies resolved from node_modules (pdf.js needs its
 * worker module and the native canvas package next to it).
 */
import {
	type DocumentLayout,
	type LayoutPage,
	type LayoutWord,
	type OcrSource,
	plainText,
} from "./layout";
import { withOcr } from "./ocr.server";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

export const MAX_PAGES = 20;
const MAX_OCR_PAGES = 10;
const DEFAULT_BUDGET_MS = 90_000;
const OCR_MAX_SIDE = 2200;

let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
	pdfjsPromise ??= (async () => {
		const main = "pdfjs-dist/legacy/build/pdf.mjs";
		const worker = "pdfjs-dist/legacy/build/pdf.worker.mjs";
		const pdfjs = (await import(/* @vite-ignore */ main)) as PdfJs;
		// Run the "worker" on the main thread (no worker file lookup in bundles).
		const g = globalThis as { pdfjsWorker?: unknown };
		g.pdfjsWorker ??= await import(/* @vite-ignore */ worker);
		return pdfjs;
	})().catch((error) => {
		pdfjsPromise = null;
		throw error;
	});
	return pdfjsPromise;
}

export type ExtractOptions = {
	/** Wall-clock budget for the whole extraction. */
	budgetMs?: number;
	/** Disable OCR (tests / when only the text layer is wanted). */
	ocr?: boolean;
};

export type ExtractedDocument = {
	layout: DocumentLayout;
	text: string;
	warnings: string[];
};

function splitItem(
	str: string,
	x: number,
	top: number,
	width: number,
	height: number,
): LayoutWord[] {
	const words: LayoutWord[] = [];
	const total = str.length || 1;
	const charWidth = width / total;
	for (const m of str.matchAll(/\S+/g)) {
		const start = m.index ?? 0;
		const x0 = x + start * charWidth;
		words.push({
			text: m[0],
			bbox: [
				round(x0),
				round(top),
				round(x0 + m[0].length * charWidth),
				round(top + height),
			],
		});
	}
	return words;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function sniffContentType(bytes: Uint8Array): string | null {
	const b = bytes;
	if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
		return "application/pdf";
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
		return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	)
		return "image/webp";
	const brand = String.fromCharCode(...b.slice(4, 12));
	if (/^ftyp(heic|heix|mif1|msf1|hevc)/.test(brand)) return "image/heic";
	return null;
}

/** Pixel size of PNG / JPEG / WebP images from their headers. */
export function imageSize(
	bytes: Uint8Array,
): { width: number; height: number } | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = sniffContentType(bytes);
	try {
		if (type === "image/png")
			return { width: view.getUint32(16), height: view.getUint32(20) };
		if (type === "image/jpeg") {
			let offset = 2;
			while (offset + 9 < bytes.length) {
				if (bytes[offset] !== 0xff) {
					offset++;
					continue;
				}
				const marker = bytes[offset + 1] ?? 0;
				const length = view.getUint16(offset + 2);
				if (
					marker >= 0xc0 &&
					marker <= 0xcf &&
					marker !== 0xc4 &&
					marker !== 0xc8 &&
					marker !== 0xcc
				)
					return {
						height: view.getUint16(offset + 5),
						width: view.getUint16(offset + 7),
					};
				offset += 2 + length;
			}
			return null;
		}
		if (type === "image/webp") {
			const chunk = String.fromCharCode(...bytes.slice(12, 16));
			if (chunk === "VP8X")
				return {
					width: 1 + (view.getUint32(24, true) & 0xffffff),
					height: 1 + (view.getUint32(27, true) & 0xffffff),
				};
			if (chunk === "VP8L") {
				const bits = view.getUint32(21, true);
				return {
					width: 1 + (bits & 0x3fff),
					height: 1 + ((bits >> 14) & 0x3fff),
				};
			}
			if (chunk === "VP8 ")
				return {
					width: view.getUint16(26, true) & 0x3fff,
					height: view.getUint16(28, true) & 0x3fff,
				};
		}
	} catch {
		return null;
	}
	return null;
}

async function extractPdf(
	bytes: Uint8Array,
	options: ExtractOptions,
	deadline: number,
): Promise<ExtractedDocument> {
	const pdfjs = await loadPdfJs();
	const warnings: string[] = [];
	const task = pdfjs.getDocument({
		// pdf.js transfers (detaches) the buffer: give it a copy.
		data: new Uint8Array(bytes),
		disableFontFace: true,
		useSystemFonts: false,
		verbosity: 0,
	});
	const doc = await task.promise;
	try {
		const pageCount = Math.min(doc.numPages, MAX_PAGES);
		if (doc.numPages > MAX_PAGES)
			warnings.push(
				`Only the first ${MAX_PAGES} of ${doc.numPages} pages were read`,
			);
		const pages: LayoutPage[] = [];
		const needOcr: number[] = [];
		for (let n = 1; n <= pageCount; n++) {
			const page = await doc.getPage(n);
			const viewport = page.getViewport({ scale: 1 });
			const content = await page.getTextContent();
			const words: LayoutWord[] = [];
			for (const item of content.items) {
				if (!("str" in item) || !item.str.trim()) continue;
				const t = pdfjs.Util.transform(viewport.transform, item.transform);
				const fontHeight = Math.hypot(t[2] ?? 0, t[3] ?? 0) || item.height;
				const x = t[4] ?? 0;
				const baseline = t[5] ?? 0;
				// Descenders: the box extends ~20% below the baseline.
				const top = baseline - fontHeight * 0.85;
				words.push(
					...splitItem(
						item.str,
						x,
						top,
						item.width * viewport.scale,
						fontHeight,
					),
				);
			}
			pages.push({
				width: round(viewport.width),
				height: round(viewport.height),
				words,
				source: "pdf-text",
			});
			if (words.length < 3) needOcr.push(n - 1);
			page.cleanup();
		}
		let ocrPages = 0;
		if (needOcr.length && options.ocr !== false) {
			await withOcr(async (ocr) => {
				for (const index of needOcr) {
					if (Date.now() > deadline) {
						warnings.push("OCR time budget exhausted; some pages were skipped");
						break;
					}
					if (ocrPages >= MAX_OCR_PAGES) {
						warnings.push(`OCR limited to ${MAX_OCR_PAGES} pages`);
						break;
					}
					const page = await doc.getPage(index + 1);
					const base = page.getViewport({ scale: 1 });
					const scale = Math.min(
						3,
						OCR_MAX_SIDE / Math.max(base.width, base.height),
					);
					const viewport = page.getViewport({ scale });
					const factory = (
						doc as unknown as {
							canvasFactory: {
								create(
									w: number,
									h: number,
								): {
									canvas: {
										encode?: (f: string) => Promise<Uint8Array>;
										toBuffer?: (m: string) => Uint8Array;
									};
								};
							};
						}
					).canvasFactory;
					const { canvas } = factory.create(
						Math.ceil(viewport.width),
						Math.ceil(viewport.height),
					);
					await page.render({
						canvas: canvas as unknown as HTMLCanvasElement,
						viewport,
					}).promise;
					const png = canvas.encode
						? await canvas.encode("png")
						: canvas.toBuffer?.("image/png");
					page.cleanup();
					if (!png) throw new Error("Page rendering is unavailable");
					const words = await ocr.recognize(png);
					const target = pages[index];
					if (!target) continue;
					target.words = words.map((w) => ({
						...w,
						bbox: [
							round(w.bbox[0] / scale),
							round(w.bbox[1] / scale),
							round(w.bbox[2] / scale),
							round(w.bbox[3] / scale),
						],
					}));
					target.source = "tesseract";
					ocrPages++;
				}
			});
		}
		const ocrSource: OcrSource =
			ocrPages === 0
				? "pdf-text"
				: ocrPages === pages.length
					? "tesseract"
					: "mixed";
		return {
			layout: { pages, ocrSource },
			text: plainText({ pages, ocrSource: "pdf-text" }),
			warnings,
		};
	} finally {
		await task.destroy().catch(() => {});
	}
}

async function extractImage(
	bytes: Uint8Array,
	options: ExtractOptions,
): Promise<ExtractedDocument> {
	const size = imageSize(bytes);
	if (!size) throw new Error("Unreadable image");
	if (options.ocr === false)
		return {
			layout: {
				pages: [{ ...size, words: [], source: "tesseract" }],
				ocrSource: "tesseract",
			},
			text: "",
			warnings: ["OCR disabled"],
		};
	const words = await withOcr((ocr) => ocr.recognize(bytes));
	const pages: LayoutPage[] = [{ ...size, words, source: "tesseract" }];
	return {
		layout: { pages, ocrSource: "tesseract" },
		text: plainText({ pages, ocrSource: "pdf-text" }),
		warnings: [],
	};
}

/** Extracts words with boxes (and plain text) from a PDF or image. */
export async function extractDocumentLayout(
	bytes: Uint8Array,
	contentType: string,
	options: ExtractOptions = {},
): Promise<ExtractedDocument> {
	const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
	const type = sniffContentType(bytes) ?? contentType;
	if (type === "application/pdf") return extractPdf(bytes, options, deadline);
	if (type === "image/png" || type === "image/jpeg" || type === "image/webp")
		return extractImage(bytes, options);
	throw new Error(`Unsupported document type ${type}`);
}
