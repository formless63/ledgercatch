import { describe, expect, it } from "vitest";
import {
	fitWithinEdge,
	fitWithinPixels,
	jpegFileName,
	MAX_PIXELS,
	type Orientation,
	orientationTransform,
	orientedSize,
	readExifOrientation,
} from "./image";

describe("fitWithinPixels", () => {
	it("never upscales small images", () => {
		expect(fitWithinPixels(1200, 1600)).toEqual({
			width: 1200,
			height: 1600,
			scale: 1,
		});
		expect(fitWithinPixels(1000, 2500)).toMatchObject({ scale: 1 });
	});

	it("downscales a 12 MP phone photo to ≤ 2.5 MP keeping aspect", () => {
		const out = fitWithinPixels(4032, 3024);
		expect(out.width * out.height).toBeLessThanOrEqual(MAX_PIXELS);
		expect(out.width * out.height).toBeGreaterThan(MAX_PIXELS * 0.99);
		expect(out.width / out.height).toBeCloseTo(4032 / 3024, 2);
		expect(out.width).toBe(1825);
	});

	it("handles 50 MP and portrait photos", () => {
		for (const [w, h] of [
			[8160, 6120],
			[3024, 4032],
			[4000, 3000],
		] as const) {
			const out = fitWithinPixels(w, h);
			expect(out.width * out.height).toBeLessThanOrEqual(MAX_PIXELS);
			expect(out.width / out.height).toBeCloseTo(w / h, 2);
		}
	});

	it("handles extreme aspect ratios (long receipts)", () => {
		const out = fitWithinPixels(800, 20_000);
		expect(out.width * out.height).toBeLessThanOrEqual(MAX_PIXELS);
		expect(out.width).toBeGreaterThanOrEqual(1);
		const tiny = fitWithinPixels(1, 10_000_000, 1000);
		expect(tiny.width).toBe(1);
		expect(tiny.height).toBeLessThanOrEqual(1000);
	});

	it("rejects invalid dimensions", () => {
		expect(() => fitWithinPixels(0, 100)).toThrow(RangeError);
		expect(() => fitWithinPixels(Number.NaN, 100)).toThrow(RangeError);
	});
});

describe("thumbnails and names", () => {
	it("fits the longest edge", () => {
		expect(fitWithinEdge(4000, 3000, 160)).toEqual({ width: 160, height: 120 });
		expect(fitWithinEdge(100, 50, 160)).toEqual({ width: 100, height: 50 });
	});
	it("renames to .jpg", () => {
		expect(jpegFileName("IMG_1.HEIC")).toBe("IMG_1.jpg");
		expect(jpegFileName("scan")).toBe("scan.jpg");
		expect(jpegFileName("")).toBe("receipt.jpg");
	});
});

describe("orientation", () => {
	it("swaps size for 90° orientations", () => {
		expect(orientedSize({ width: 40, height: 30 }, 6)).toEqual({
			width: 30,
			height: 40,
		});
		expect(orientedSize({ width: 40, height: 30 }, 3)).toEqual({
			width: 40,
			height: 30,
		});
	});

	it("maps raw corners inside the oriented canvas", () => {
		const size = { width: 40, height: 30 };
		for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as Orientation[]) {
			const [a, b, c, d, e, f] = orientationTransform(o, size);
			const out = orientedSize(size, o);
			const corners = [
				[0, 0],
				[size.width, 0],
				[0, size.height],
				[size.width, size.height],
			].map(([x = 0, y = 0]) => [a * x + c * y + e, b * x + d * y + f]);
			const xs = corners.map((p) => p[0]).sort((m, n) => (m ?? 0) - (n ?? 0));
			const ys = corners.map((p) => p[1]).sort((m, n) => (m ?? 0) - (n ?? 0));
			expect([xs[0], xs[3], ys[0], ys[3]]).toEqual([
				0,
				out.width,
				0,
				out.height,
			]);
		}
	});

	it("rotates orientation 6 clockwise (top-left → top-right)", () => {
		const [a, b, c, d, e, f] = orientationTransform(6, {
			width: 40,
			height: 30,
		});
		expect([a * 0 + c * 0 + e, b * 0 + d * 0 + f]).toEqual([30, 0]);
	});
});

function jpegWithOrientation(value: number, little: boolean) {
	const bytes: number[] = [0xff, 0xd8];
	// APP0 (JFIF) segment first, to check marker skipping.
	bytes.push(0xff, 0xe0, 0x00, 0x04, 0x00, 0x00);
	const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
	const u32 = (n: number) =>
		little
			? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
			: [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
	const tiff = [
		...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
		...u16(0x2a),
		...u32(8),
		...u16(2),
		// unrelated tag (ImageWidth)
		...u16(0x0100),
		...u16(3),
		...u32(1),
		...u16(640),
		0,
		0,
		// Orientation
		...u16(0x0112),
		...u16(3),
		...u32(1),
		...u16(value),
		0,
		0,
		...u32(0),
	];
	const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
	const length = payload.length + 2;
	bytes.push(0xff, 0xe1, length >> 8, length & 0xff, ...payload);
	bytes.push(0xff, 0xda, 0x00, 0x02);
	return new Uint8Array(bytes).buffer;
}

describe("readExifOrientation", () => {
	it("reads big- and little-endian EXIF", () => {
		expect(readExifOrientation(jpegWithOrientation(6, false))).toBe(6);
		expect(readExifOrientation(jpegWithOrientation(8, true))).toBe(8);
		expect(readExifOrientation(jpegWithOrientation(3, true))).toBe(3);
	});
	it("defaults to 1 for invalid or missing data", () => {
		expect(readExifOrientation(jpegWithOrientation(42, true))).toBe(1);
		expect(
			readExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer),
		).toBe(1);
		expect(
			readExifOrientation(
				new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer,
			),
		).toBe(1);
		expect(readExifOrientation(new ArrayBuffer(0))).toBe(1);
	});
});
