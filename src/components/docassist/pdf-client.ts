/** Browser-side pdf.js loader (lazy; never imported on the server). */
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJsModule = typeof import("pdfjs-dist");

let modulePromise: Promise<PdfJsModule> | null = null;

export function loadPdfJs(): Promise<PdfJsModule> {
	modulePromise ??= (async () => {
		const [pdfjs, worker] = await Promise.all([
			import("pdfjs-dist"),
			import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
		]);
		pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		return pdfjs;
	})().catch((error) => {
		modulePromise = null;
		throw error;
	});
	return modulePromise;
}

/** Loads a PDF from a same-origin URL (session cookie). */
export async function openPdf(url: string): Promise<{
	doc: PDFDocumentProxy;
	destroy: () => void;
}> {
	const pdfjs = await loadPdfJs();
	const task = pdfjs.getDocument({
		url,
		withCredentials: true,
	});
	const doc = await task.promise;
	return { doc, destroy: () => void task.destroy() };
}
