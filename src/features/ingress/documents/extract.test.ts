import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractDocumentLayout,
	imageSize,
	sniffContentType,
} from "./extract.server";
import { extractFields } from "./fields";
import { textOfRefs } from "./layout";
import { makeTestPdf } from "./test-pdf";

const runs = [
	{ x: 50, y: 740, size: 22, text: "Fabrikam Tools" },
	{ x: 380, y: 700, size: 10, text: "Order #: FT-55120" },
	{ x: 380, y: 686, size: 10, text: "Order Date: 2026-02-01" },
	{ x: 400, y: 200, size: 10, text: "Subtotal: $40.00" },
	{ x: 400, y: 186, size: 10, text: "Tax: $3.20" },
	{ x: 400, y: 172, size: 10, text: "Total: $43.20" },
];

describe("PDF text extraction", () => {
	it("reads words with top-left boxes in PDF points", async () => {
		const pdf = makeTestPdf(runs);
		expect(sniffContentType(pdf)).toBe("application/pdf");
		const { layout, text } = await extractDocumentLayout(
			pdf,
			"application/pdf",
			{
				ocr: false,
			},
		);
		expect(layout.ocrSource).toBe("pdf-text");
		const page = layout.pages[0];
		expect(page?.width).toBe(612);
		expect(page?.height).toBe(792);
		const fabrikam = page?.words.find((w) => w.text === "Fabrikam");
		// Baseline at 792 − 740 = 52 from the top; 22pt font.
		expect(fabrikam?.bbox[0]).toBeCloseTo(50, 0);
		expect(fabrikam?.bbox[3]).toBeGreaterThan(52);
		expect(fabrikam?.bbox[1]).toBeLessThan(40);
		expect(text).toContain("Order #: FT-55120");

		const { fields } = extractFields(layout);
		expect(fields.externalOrderId?.value).toBe("FT-55120");
		expect(fields.orderDate?.value).toBe("2026-02-01");
		expect(fields.total?.value).toBe("43.20");
		expect(fields.merchantName?.value).toBe("Fabrikam Tools");
		expect(textOfRefs(layout, fields.total?.refs ?? [])).toBe("$43.20");
	});

	it("reads image sizes from headers", () => {
		const png = new Uint8Array(24);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		new DataView(png.buffer).setUint32(16, 640);
		new DataView(png.buffer).setUint32(20, 480);
		expect(imageSize(png)).toEqual({ width: 640, height: 480 });
	});
});

// OCR needs eng.traineddata(.gz) locally (OCR_LANG_PATH); skipped otherwise so
// CI never downloads language data.
const langPath = process.env.OCR_LANG_PATH;
const hasLangData =
	!!langPath &&
	(existsSync(path.join(langPath, "eng.traineddata.gz")) ||
		existsSync(path.join(langPath, "eng.traineddata")));

describe.skipIf(!hasLangData)("OCR (tesseract)", () => {
	it("OCRs a rendered page image into word boxes", async () => {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = pdfjs.getDocument({ data: makeTestPdf(runs), verbosity: 0 });
		const doc = await task.promise;
		const page = await doc.getPage(1);
		const viewport = page.getViewport({ scale: 1.5 });
		const factory = (
			doc as unknown as {
				canvasFactory: {
					create(
						w: number,
						h: number,
					): { canvas: { encode(f: string): Promise<Uint8Array> } };
				};
			}
		).canvasFactory;
		const { canvas } = factory.create(viewport.width, viewport.height);
		await page.render({
			canvas: canvas as unknown as HTMLCanvasElement,
			viewport,
		}).promise;
		const png = await canvas.encode("png");
		await task.destroy();
		const { layout } = await extractDocumentLayout(png, "image/png");
		expect(layout.ocrSource).toBe("tesseract");
		const { fields } = extractFields(layout);
		expect(fields.externalOrderId?.value).toBe("FT-55120");
		expect(fields.total?.value).toBe("43.20");
	}, 60_000);
});
