import { createHash, randomUUID } from "node:crypto";
import type { createStorage } from "../storage/storage.server";
import {
	type FileContext,
	FileError,
	type FileMetadata,
	type FileRecord,
	fileView,
} from "./contract";
export type FileStorage = Pick<
	ReturnType<typeof createStorage>,
	"createKey" | "putObject" | "headObject" | "getObject" | "deleteObject"
>;
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export async function readFileBytes(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	signal?: AbortSignal,
) {
	if (!body) throw new FileError("invalid_input");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			if (signal?.aborted) throw new FileError("cancelled");
			const part = await reader.read();
			if (signal?.aborted) throw new FileError("cancelled");
			if (part.done) break;
			size += part.value.byteLength;
			if (size > maxBytes) throw new FileError("too_large");
			chunks.push(part.value);
		}
		return Buffer.concat(chunks, size);
	} finally {
		signal?.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
export function createFileWorkflow(options: {
	metadata: FileMetadata;
	storage: () => FileStorage;
	authorize: (ctx: FileContext, action: "read" | "write") => Promise<boolean>;
	maxBytes?: number;
}) {
	const { metadata } = options;
	const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > 100 * 1024 * 1024
	)
		throw new FileError("invalid_input");
	async function authorize(ctx: FileContext, action: "read" | "write") {
		if (
			!ctx.owner ||
			ctx.owner.length > 256 ||
			!(await options.authorize(ctx, action))
		)
			throw new FileError("forbidden");
	}
	async function get(ctx: FileContext, id: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new FileError("invalid_input");
		const row = await metadata.get(ctx.owner, id);
		if (!row) throw new FileError("not_found");
		return row;
	}
	async function cleanup(row: FileRecord): Promise<FileRecord> {
		if (row.state !== "cleanup-pending" || !row.writerStopped) return row;
		try {
			await options.storage().deleteObject(row.key);
		} catch {
			return row;
		}
		// Delete has its own transport lifetime, never the cancelled upload signal.
		try {
			return (
				(await metadata.cas(row.owner, row.id, row.revision, {
					state: "removed",
					writerStopped: true,
				})) ??
				(await metadata.get(row.owner, row.id)) ??
				row
			);
		} catch {
			throw new FileError("unavailable");
		}
	}
	async function settleFailure(row: FileRecord, writerStopped: boolean) {
		// A metadata exception can be an acknowledged commit with a lost response. Read before any delete.
		let current: FileRecord | undefined;
		try {
			current = await metadata.get(row.owner, row.id);
			if (!current) throw new FileError("unavailable");
			if (current.state === "ready" || current.state === "removed")
				return current;
			if (
				current.state === "uploading" ||
				(writerStopped && !current.writerStopped)
			) {
				current =
					(await metadata.cas(current.owner, current.id, current.revision, {
						state: "cleanup-pending",
						writerStopped,
					})) ?? (await metadata.get(row.owner, row.id));
			}
		} catch {
			throw new FileError("unavailable");
		}
		if (!current) throw new FileError("unavailable");
		return cleanup(current);
	}
	return {
		maxBytes,
		async list(ctx: FileContext) {
			await authorize(ctx, "read");
			return (await metadata.list(ctx.owner, 100)).map(fileView);
		},
		async upload(
			ctx: FileContext,
			input: {
				token: string;
				name: string;
				type: string;
				body: ReadableStream<Uint8Array> | null;
				expectedSize?: number;
				expectedDigest?: string;
			},
		) {
			await authorize(ctx, "write");
			if (
				!/^[A-Za-z0-9_-]{16,128}$/.test(input.token) ||
				typeof input.name !== "string" ||
				input.name.length < 1 ||
				input.name.length > 180 ||
				Array.from(input.name).some(
					(char) =>
						char.charCodeAt(0) < 32 ||
						char.charCodeAt(0) === 127 ||
						char === "/" ||
						char === "\\",
				) ||
				!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.type) ||
				input.type.length > 128
			)
				throw new FileError("invalid_input");
			const name = input.name.normalize("NFC").trim();
			const type = input.type.toLowerCase();
			if (!name || name === "." || name === "..")
				throw new FileError("invalid_input");
			const bytes = await readFileBytes(input.body, maxBytes, ctx.signal);
			const hash = digest(bytes);
			if (
				(input.expectedSize !== undefined &&
					input.expectedSize !== bytes.length) ||
				(input.expectedDigest !== undefined && input.expectedDigest !== hash)
			)
				throw new FileError("invalid_input");
			const fingerprint = digest(
				Buffer.from(JSON.stringify([hash, bytes.length, name, type])),
			);
			const storage = options.storage();
			const proposed: FileRecord = {
				id: randomUUID(),
				owner: ctx.owner,
				key: storage.createKey("file-ui"),
				idempotencyKey: input.token,
				digest: hash,
				fingerprint,
				name,
				type,
				size: bytes.length,
				state: "uploading",
				writerStopped: false,
				revision: 0,
				createdAt: Date.now(),
			};
			let reserved: { created: boolean; record: FileRecord };
			try {
				reserved = await metadata.reserve(proposed);
			} catch {
				// Do not launch a PUT after an uncertain reserve, even if a receipt becomes visible.
				const existing = await metadata
					.byToken(ctx.owner, input.token)
					.catch(() => undefined);
				if (existing && existing.fingerprint !== fingerprint)
					throw new FileError("conflict");
				if (existing) return fileView(existing);
				throw new FileError("unavailable");
			}
			const row = reserved.record;
			if (row.fingerprint !== fingerprint) throw new FileError("conflict");
			if (!reserved.created) return fileView(row);
			let writerStopped = false;
			try {
				if (ctx.signal?.aborted) {
					writerStopped = true;
					throw new FileError("cancelled");
				}
				await storage.putObject(row.key, bytes, {
					contentType: type,
					contentLength: bytes.length,
					metadata: { sha256: hash },
					signal: ctx.signal,
				});
				writerStopped = true;
				const actual = await storage.headObject(row.key, {
					signal: ctx.signal,
				});
				if (
					actual.contentLength !== row.size ||
					actual.contentType !== row.type ||
					actual.metadata.sha256 !== hash
				)
					throw new FileError("invalid_input");
				const verification = await storage.getObject(row.key, {
					signal: ctx.signal,
				});
				if (!verification.body) throw new FileError("unavailable");
				const verified = await readFileBytes(
					verification.body.transformToWebStream(),
					maxBytes,
					ctx.signal,
				);
				if (verified.length !== row.size || digest(verified) !== hash)
					throw new FileError("invalid_input");
				if (ctx.signal?.aborted) throw new FileError("cancelled");
				const ready = await metadata.cas(row.owner, row.id, row.revision, {
					state: "ready",
					writerStopped: true,
				});
				if (!ready) return fileView(await settleFailure(row, true));
				return fileView(ready);
			} catch {
				return fileView(await settleFailure(row, writerStopped));
			}
		},
		async remove(ctx: FileContext, id: string) {
			await authorize(ctx, "write");
			let row = await get(ctx, id);
			if (row.state === "removed") return fileView(row);
			if (row.state !== "cleanup-pending")
				row =
					(await metadata.cas(row.owner, row.id, row.revision, {
						state: "cleanup-pending",
						writerStopped: row.writerStopped,
					})) ?? (await get(ctx, id));
			return fileView(await cleanup(row));
		},
		async download(ctx: FileContext, id: string) {
			await authorize(ctx, "read");
			const row = await get(ctx, id);
			if (row.state !== "ready") throw new FileError("not_found");
			const object = await options
				.storage()
				.getObject(row.key, { signal: ctx.signal });
			if (!object.body) throw new FileError("unavailable");
			return {
				body: object.body,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "private, no-store",
					"Content-Security-Policy": "sandbox; default-src 'none'",
				},
			};
		},
		/** Server/operator only: stop/fence all prior writers BEFORE asserting this; expiry alone is insufficient. */
		async reconcile(
			ctx: FileContext,
			id: string,
			attestation: { writersStopped: boolean },
		) {
			await authorize(ctx, "write");
			let row = await get(ctx, id);
			if (row.state === "ready" || row.state === "removed")
				return fileView(row);
			row =
				(await metadata.cas(row.owner, row.id, row.revision, {
					state: "cleanup-pending",
					writerStopped: row.writerStopped || attestation.writersStopped,
				})) ?? (await get(ctx, id));
			return fileView(await cleanup(row));
		},
	};
}
