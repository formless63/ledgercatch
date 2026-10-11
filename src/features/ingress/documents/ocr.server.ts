/**
 * Tesseract OCR (tesseract.js, WASM) with offline language data.
 *
 * Language data resolution (first hit wins):
 *   1. $OCR_LANG_PATH                    — directory holding eng.traineddata(.gz)
 *   2. <cwd>/tessdata                     — e.g. /app/tessdata in the image
 *   3. $OCR_CACHE_DIR (default <tmp>/ledgercatch-tessdata) — a previous download
 *   4. one-time download from jsDelivr into (3), unless OCR_ALLOW_DOWNLOAD=false
 *
 * tesseract.js spawns a worker_thread from its own package files and loads
 * its WASM core with require(), so it must stay an external runtime
 * dependency (resolved from node_modules), never bundled — hence the
 * non-literal import specifier below.
 */
import { createWriteStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LayoutWord } from "./layout";

const LANG = "eng";
const CDN =
	"https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int";

type TesseractWord = {
	text: string;
	confidence: number;
	bbox: { x0: number; y0: number; x1: number; y1: number };
};
type TesseractWorker = {
	recognize(
		image: Buffer | Uint8Array,
		options?: Record<string, unknown>,
		output?: Record<string, boolean>,
	): Promise<{
		data: {
			text: string;
			blocks: Array<{
				paragraphs: Array<{ lines: Array<{ words: TesseractWord[] }> }>;
			}> | null;
		};
	}>;
	terminate(): Promise<unknown>;
};
type TesseractModule = {
	createWorker(
		langs: string,
		oem?: number,
		options?: Record<string, unknown>,
	): Promise<TesseractWorker>;
};

async function exists(file: string) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

async function findLangDir(dir: string | undefined) {
	if (!dir) return null;
	if (await exists(path.join(dir, `${LANG}.traineddata.gz`)))
		return { langPath: dir, gzip: true };
	if (await exists(path.join(dir, `${LANG}.traineddata`)))
		return { langPath: dir, gzip: false };
	return null;
}

let downloading: Promise<void> | null = null;

async function download(dir: string) {
	await mkdir(dir, { recursive: true });
	const target = path.join(dir, `${LANG}.traineddata.gz`);
	const temp = `${target}.${process.pid}.part`;
	const response = await fetch(`${CDN}/${LANG}.traineddata.gz`, {
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok || !response.body)
		throw new Error(`OCR language data download failed (${response.status})`);
	await pipeline(
		Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
		createWriteStream(temp),
	);
	await rename(temp, target);
}

export async function resolveLanguageData(): Promise<{
	langPath: string;
	gzip: boolean;
}> {
	const configured = await findLangDir(process.env.OCR_LANG_PATH);
	if (configured) return configured;
	const local = await findLangDir(path.join(process.cwd(), "tessdata"));
	if (local) return local;
	const cacheDir =
		process.env.OCR_CACHE_DIR || path.join(tmpdir(), "ledgercatch-tessdata");
	const cached = await findLangDir(cacheDir);
	if (cached) return cached;
	if (process.env.OCR_ALLOW_DOWNLOAD === "false")
		throw new Error(
			"OCR language data not found: set OCR_LANG_PATH to a directory containing eng.traineddata.gz",
		);
	downloading ??= download(cacheDir).finally(() => {
		downloading = null;
	});
	await downloading;
	const fetched = await findLangDir(cacheDir);
	if (!fetched) throw new Error("OCR language data unavailable");
	return fetched;
}

async function loadTesseract(): Promise<TesseractModule> {
	const specifier = "tesseract.js";
	const mod = (await import(/* @vite-ignore */ specifier)) as
		| TesseractModule
		| { default: TesseractModule };
	return "createWorker" in mod ? mod : mod.default;
}

// One OCR run at a time per process: each worker holds ~100–200 MB of WASM.
let queue: Promise<unknown> = Promise.resolve();

export type OcrSession = {
	recognize(image: Uint8Array): Promise<LayoutWord[]>;
};

/** Runs `fn` with an OCR worker (serialized per process, always terminated). */
export function withOcr<T>(fn: (ocr: OcrSession) => Promise<T>): Promise<T> {
	const run = async () => {
		const [{ createWorker }, lang] = await Promise.all([
			loadTesseract(),
			resolveLanguageData(),
		]);
		const worker = await createWorker(LANG, 1, {
			langPath: lang.langPath,
			gzip: lang.gzip,
			// Never write traineddata copies into the working directory.
			cacheMethod: "none",
			logger: () => {},
			errorHandler: () => {},
		});
		try {
			return await fn({
				async recognize(image) {
					const { data } = await worker.recognize(
						Buffer.from(image),
						{},
						{ blocks: true, text: false },
					);
					const words: LayoutWord[] = [];
					for (const block of data.blocks ?? [])
						for (const paragraph of block.paragraphs)
							for (const line of paragraph.lines)
								for (const word of line.words) {
									const text = word.text.trim();
									if (!text) continue;
									words.push({
										text,
										bbox: [
											word.bbox.x0,
											word.bbox.y0,
											word.bbox.x1,
											word.bbox.y1,
										],
										conf: Math.round(word.confidence),
									});
								}
					return words;
				},
			});
		} finally {
			await worker.terminate().catch(() => {});
		}
	};
	const result = queue.then(run, run);
	queue = result.catch(() => {});
	return result;
}
