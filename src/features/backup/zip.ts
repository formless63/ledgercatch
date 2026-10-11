/**
 * Minimal streaming ZIP writer (PKZIP 2.0: stored/deflate, UTF-8 names, no
 * ZIP64). No third-party dependency: entries are compressed with node:zlib
 * and written to an async sink one at a time, so memory is bounded by the
 * largest single entry, not the archive.
 *
 * The API mirrors fflate's Zip/ZipDeflate shape closely enough that it can be
 * swapped for fflate/yazl/archiver behind `createZipWriter` later.
 */
import { deflateRawSync } from "node:zlib";

export type ZipSink = (chunk: Uint8Array) => Promise<void>;

export class ZipLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipLimitError";
	}
}

/** Classic ZIP caps (no ZIP64): 65 535 entries, offsets < 4 GiB. */
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff;

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array, previous = 0): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	const table = crcTable;
	let crc = (previous ^ 0xffff_ffff) >>> 0;
	for (let i = 0; i < data.length; i++)
		crc = (table[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
	return (crc ^ 0xffff_ffff) >>> 0;
}

function dosDateTime(date: Date) {
	const year = Math.max(1980, Math.min(2107, date.getFullYear()));
	return {
		time:
			(date.getHours() << 11) |
			(date.getMinutes() << 5) |
			Math.floor(date.getSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** Safe archive path: forward slashes, no traversal, no leading slash. */
export function safeZipPath(path: string) {
	const cleaned = path
		.replace(/\\/g, "/")
		.split("/")
		.map((segment) =>
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control chars
			segment.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").trim(),
		)
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.join("/");
	return cleaned || "unnamed";
}

type CentralEntry = {
	name: Uint8Array;
	method: number;
	time: number;
	date: number;
	crc: number;
	compressedSize: number;
	size: number;
	offset: number;
};

export type ZipWriter = {
	/** Add one file. `compress` defaults to true (skipped if it doesn't help). */
	add(
		path: string,
		data: Uint8Array | string,
		options?: { compress?: boolean; modified?: Date },
	): Promise<void>;
	/** Would adding `bytes` more data overflow the configured bound? */
	fits(bytes: number): boolean;
	finish(): Promise<{ bytes: number; entries: number }>;
	readonly bytesWritten: number;
	readonly entries: number;
};

export function createZipWriter(
	sink: ZipSink,
	options: { maxBytes?: number } = {},
): ZipWriter {
	const maxBytes = Math.min(options.maxBytes ?? ZIP_MAX_BYTES, ZIP_MAX_BYTES);
	const central: CentralEntry[] = [];
	const names = new Set<string>();
	const encoder = new TextEncoder();
	let offset = 0;
	let finished = false;

	async function write(chunk: Uint8Array) {
		offset += chunk.byteLength;
		await sink(chunk);
	}

	function uniqueName(path: string) {
		let name = safeZipPath(path);
		if (names.has(name)) {
			const dot = name.lastIndexOf(".");
			const slash = name.lastIndexOf("/");
			const [stem, ext] =
				dot > slash + 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
			let n = 2;
			while (names.has(`${stem}-${n}${ext}`)) n++;
			name = `${stem}-${n}${ext}`;
		}
		names.add(name);
		return name;
	}

	const writer: ZipWriter = {
		get bytesWritten() {
			return offset;
		},
		get entries() {
			return central.length;
		},
		fits(bytes) {
			// Local header + name (≤ 1 KiB) + central record + EOCD headroom.
			const centralSize = central.reduce(
				(sum, entry) => sum + 46 + entry.name.byteLength,
				0,
			);
			return (
				central.length + 1 < ZIP_MAX_ENTRIES &&
				offset + bytes + centralSize + 4096 <= maxBytes
			);
		},
		async add(path, input, addOptions = {}) {
			if (finished) throw new Error("ZIP already finished");
			const data = typeof input === "string" ? encoder.encode(input) : input;
			const name = encoder.encode(uniqueName(path));
			if (name.byteLength > 0xffff) throw new ZipLimitError("Path too long");
			let body = data;
			let method = 0;
			if (addOptions.compress !== false && data.byteLength > 64) {
				const deflated = deflateRawSync(data, { level: 6 });
				if (deflated.byteLength < data.byteLength) {
					body = deflated;
					method = 8;
				}
			}
			if (!writer.fits(body.byteLength + 30 + name.byteLength))
				throw new ZipLimitError("Archive size limit reached");
			const crc = crc32(data);
			const { time, date } = dosDateTime(addOptions.modified ?? new Date());
			const header = new DataView(new ArrayBuffer(30));
			header.setUint32(0, 0x0403_4b50, true);
			header.setUint16(4, 20, true);
			header.setUint16(6, 0x0800, true); // UTF-8 names
			header.setUint16(8, method, true);
			header.setUint16(10, time, true);
			header.setUint16(12, date, true);
			header.setUint32(14, crc, true);
			header.setUint32(18, body.byteLength, true);
			header.setUint32(22, data.byteLength, true);
			header.setUint16(26, name.byteLength, true);
			header.setUint16(28, 0, true);
			const entryOffset = offset;
			await write(new Uint8Array(header.buffer));
			await write(name);
			await write(body);
			central.push({
				name,
				method,
				time,
				date,
				crc,
				compressedSize: body.byteLength,
				size: data.byteLength,
				offset: entryOffset,
			});
		},
		async finish() {
			if (finished) throw new Error("ZIP already finished");
			finished = true;
			const start = offset;
			for (const entry of central) {
				const record = new DataView(new ArrayBuffer(46));
				record.setUint32(0, 0x0201_4b50, true);
				record.setUint16(4, (3 << 8) | 20, true); // made by: unix, 2.0
				record.setUint16(6, 20, true);
				record.setUint16(8, 0x0800, true);
				record.setUint16(10, entry.method, true);
				record.setUint16(12, entry.time, true);
				record.setUint16(14, entry.date, true);
				record.setUint32(16, entry.crc, true);
				record.setUint32(20, entry.compressedSize, true);
				record.setUint32(24, entry.size, true);
				record.setUint16(28, entry.name.byteLength, true);
				record.setUint16(30, 0, true);
				record.setUint16(32, 0, true);
				record.setUint16(34, 0, true);
				record.setUint16(36, 0, true);
				record.setUint32(38, (0o100644 << 16) >>> 0, true); // -rw-r--r--
				record.setUint32(42, entry.offset, true);
				await write(new Uint8Array(record.buffer));
				await write(entry.name);
			}
			const size = offset - start;
			const end = new DataView(new ArrayBuffer(22));
			end.setUint32(0, 0x0605_4b50, true);
			end.setUint16(4, 0, true);
			end.setUint16(6, 0, true);
			end.setUint16(8, central.length, true);
			end.setUint16(10, central.length, true);
			end.setUint32(12, size, true);
			end.setUint32(16, start, true);
			end.setUint16(20, 0, true);
			await write(new Uint8Array(end.buffer));
			return { bytes: offset, entries: central.length };
		},
	};
	return writer;
}
