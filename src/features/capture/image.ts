/**
 * Client-side image preparation for mobile receipt capture.
 *
 * Phone photos (12–50 MP, 3–12 MB) are downscaled to ≤ 2.5 MP and re-encoded
 * as JPEG (q 0.85) before upload. Re-encoding also strips EXIF (GPS location,
 * device serials). Orientation: every current browser applies EXIF
 * orientation when decoding into an <img> and drawing it to a canvas
 * (`image-orientation: from-image`); for older engines we read the EXIF
 * orientation tag ourselves and apply the transform manually.
 *
 * The sizing/EXIF/transform helpers are pure and unit-tested; `prepareFile`
 * is the browser-only entry point.
 */

export const MAX_PIXELS = 2_500_000;
export const JPEG_QUALITY = 0.85;
export const THUMB_EDGE = 160;

export type Size = { width: number; height: number };

/** Largest size with the same aspect ratio whose area is ≤ maxPixels (never upscales). */
export function fitWithinPixels(
	width: number,
	height: number,
	maxPixels = MAX_PIXELS,
): Size & { scale: number } {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		maxPixels < 1
	)
		throw new RangeError("Image dimensions must be positive");
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
	if (scale === 1)
		return {
			width: Math.round(width),
			height: Math.round(height),
			scale: 1,
		};
	let w = Math.max(1, Math.floor(width * scale));
	let h = Math.max(1, Math.floor(height * scale));
	// Extreme aspect ratios can push the clamped side over; shave the long side.
	while (w * h > maxPixels) {
		if (w >= h) w -= 1;
		else h -= 1;
	}
	return { width: w, height: h, scale };
}

/** Largest size fitting in a square box (thumbnails). */
export function fitWithinEdge(width: number, height: number, edge: number) {
	const scale = Math.min(1, edge / Math.max(width, height));
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Orientations 5–8 rotate by 90°, swapping the displayed width/height. */
export function orientedSize(size: Size, orientation: Orientation): Size {
	return orientation >= 5
		? { width: size.height, height: size.width }
		: { ...size };
}

/**
 * Canvas transform (ctx.transform(a, b, c, d, e, f)) that draws a raw,
 * unrotated image of `size` upright into a canvas of `orientedSize(size)`.
 */
export function orientationTransform(
	orientation: Orientation,
	{ width: w, height: h }: Size,
): [number, number, number, number, number, number] {
	switch (orientation) {
		case 2:
			return [-1, 0, 0, 1, w, 0];
		case 3:
			return [-1, 0, 0, -1, w, h];
		case 4:
			return [1, 0, 0, -1, 0, h];
		case 5:
			return [0, 1, 1, 0, 0, 0];
		case 6:
			return [0, 1, -1, 0, h, 0];
		case 7:
			return [0, -1, -1, 0, h, w];
		case 8:
			return [0, -1, 1, 0, 0, w];
		default:
			return [1, 0, 0, 1, 0, 0];
	}
}

/** Reads the EXIF orientation tag (0x0112) from JPEG bytes; 1 when absent. */
export function readExifOrientation(buffer: ArrayBuffer): Orientation {
	const view = new DataView(buffer);
	if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
	let offset = 2;
	while (offset + 4 <= view.byteLength) {
		const marker = view.getUint16(offset);
		if ((marker & 0xff00) !== 0xff00) return 1;
		// Start of scan / end of image: no more metadata segments.
		if (marker === 0xffda || marker === 0xffd9) return 1;
		const length = view.getUint16(offset + 2);
		if (length < 2) return 1;
		if (marker === 0xffe1) return readApp1(view, offset + 4, length - 2);
		offset += 2 + length;
	}
	return 1;
}

function readApp1(view: DataView, start: number, length: number): Orientation {
	const end = Math.min(view.byteLength, start + length);
	// "Exif\0\0"
	if (end - start < 14 || view.getUint32(start) !== 0x45786966) return 1;
	const tiff = start + 6;
	const order = view.getUint16(tiff);
	const little = order === 0x4949;
	if (!little && order !== 0x4d4d) return 1;
	if (view.getUint16(tiff + 2, little) !== 0x002a) return 1;
	const ifd = tiff + view.getUint32(tiff + 4, little);
	if (ifd + 2 > end) return 1;
	const entries = view.getUint16(ifd, little);
	for (let i = 0; i < entries; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > end) return 1;
		if (view.getUint16(entry, little) === 0x0112) {
			const value = view.getUint16(entry + 8, little);
			return value >= 1 && value <= 8 ? (value as Orientation) : 1;
		}
	}
	return 1;
}

/** "IMG_1234.HEIC" → "IMG_1234.jpg" */
export function jpegFileName(name: string) {
	const base = (name || "receipt").replace(/\.[^./\\]{1,8}$/, "");
	return `${base || "receipt"}.jpg`;
}

export type PreparedFile = {
	blob: Blob;
	fileName: string;
	contentType: string;
	originalSize: number;
	/** Small JPEG data URL for the queue list (images only). */
	thumbnail: string | null;
	width?: number;
	height?: number;
};

/* ───────────────────────── browser only ───────────────────────── */

function browserAppliesOrientation() {
	return (
		typeof CSS !== "undefined" &&
		typeof CSS.supports === "function" &&
		CSS.supports("image-orientation", "from-image")
	);
}

async function loadImage(file: Blob) {
	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.decoding = "async";
		img.src = url;
		await img.decode();
		return img;
	} finally {
		// The decoded bitmap stays usable for drawImage after revoking.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
	return new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(blob) =>
				blob ? resolve(blob) : reject(new Error("Could not encode image")),
			"image/jpeg",
			quality,
		),
	);
}

function draw(
	img: HTMLImageElement,
	target: Size,
	orientation: Orientation,
): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	const out = orientedSize(target, orientation);
	canvas.width = out.width;
	canvas.height = out.height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas unavailable");
	// Receipts are mostly white paper; avoid black where alpha existed (PNG).
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, out.width, out.height);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	ctx.transform(...orientationTransform(orientation, target));
	ctx.drawImage(img, 0, 0, target.width, target.height);
	return canvas;
}

/**
 * Downscale + re-encode an image; PDFs (and anything the browser cannot
 * decode, e.g. HEIC outside Safari) are passed through untouched — the server
 * reports unsupported types per file.
 */
export async function prepareFile(file: File): Promise<PreparedFile> {
	const passthrough: PreparedFile = {
		blob: file,
		fileName: file.name || "document",
		contentType: file.type || "application/octet-stream",
		originalSize: file.size,
		thumbnail: null,
	};
	if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name))
		return passthrough;
	try {
		const img = await loadImage(file);
		const auto = browserAppliesOrientation();
		const orientation: Orientation =
			auto || !/jpe?g$/i.test(file.type)
				? 1
				: readExifOrientation(await file.slice(0, 256 * 1024).arrayBuffer());
		// With auto-orientation natural* is already upright; otherwise it is raw.
		const raw = { width: img.naturalWidth, height: img.naturalHeight };
		const fit = fitWithinPixels(raw.width, raw.height);
		const canvas = draw(img, fit, orientation);
		const blob = await canvasToBlob(canvas, JPEG_QUALITY);
		const thumbSize = fitWithinEdge(canvas.width, canvas.height, THUMB_EDGE);
		const thumb = document.createElement("canvas");
		thumb.width = thumbSize.width;
		thumb.height = thumbSize.height;
		thumb
			.getContext("2d")
			?.drawImage(canvas, 0, 0, thumbSize.width, thumbSize.height);
		return {
			blob,
			fileName: jpegFileName(file.name),
			contentType: "image/jpeg",
			originalSize: file.size,
			thumbnail: thumb.toDataURL("image/jpeg", 0.6),
			width: canvas.width,
			height: canvas.height,
		};
	} catch {
		return passthrough;
	}
}
