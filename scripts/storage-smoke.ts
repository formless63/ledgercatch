import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { ListPartsCommand } from "@aws-sdk/client-s3";
import { storageConfig } from "../src/integrations/storage/config.server";
import {
	StorageError,
	storageError,
} from "../src/integrations/storage/errors.server";
import { getStorage } from "../src/integrations/storage/storage.server";

export async function storageSmoke(storage = getStorage()) {
	const prefix = `${storage.createKey("smoke")}/`;
	const keys = ["stream", "signed", "multi", "aborted"].map(
		(name) => `${prefix}${name}`,
	);
	const uploads = new Map<string, string>();
	const text = "storage smoke, private and portable";
	try {
		await storage.checkStorage();
		if (process.env.STORAGE_SMOKE_CORS_ORIGIN) {
			const origin = process.env.STORAGE_SMOKE_CORS_ORIGIN;
			const preflight = await fetch(
				`${process.env.STORAGE_ENDPOINT}/${storageConfig().bucket}/${keys[1]}`,
				{
					method: "OPTIONS",
					headers: {
						Origin: origin,
						"Access-Control-Request-Method": "PUT",
						"Access-Control-Request-Headers": "content-type",
					},
				},
			);
			await preflight.arrayBuffer();
			assert.equal(preflight.ok, true);
			assert.equal(
				preflight.headers.get("access-control-allow-origin"),
				origin,
			);
			const untrusted = await fetch(
				`${process.env.STORAGE_ENDPOINT}/${storageConfig().bucket}/${keys[1]}`,
				{
					method: "OPTIONS",
					headers: {
						Origin: "https://untrusted.invalid",
						"Access-Control-Request-Method": "PUT",
						"Access-Control-Request-Headers": "content-type",
					},
				},
			);
			await untrusted.arrayBuffer();
			// Browser preflights require both success and a matching origin grant.
			const allowedOrigin = untrusted.headers.get(
				"access-control-allow-origin",
			);
			assert.ok(
				!untrusted.ok ||
					(allowedOrigin !== "*" &&
						allowedOrigin !== "https://untrusted.invalid"),
			);
		}
		await storage.putObject(keys[0]!, Readable.from([text]), {
			contentLength: Buffer.byteLength(text),
			contentType: "text/plain",
			cacheControl: "private, max-age=60",
			metadata: { purpose: "smoke" },
		});
		const head = await storage.headObject(keys[0]!);
		assert.equal(head.contentLength, Buffer.byteLength(text));
		assert.equal(head.contentType, "text/plain");
		assert.equal(head.metadata.purpose, "smoke");
		assert.equal(head.cacheControl, "private, max-age=60");
		assert.ok(head.etag);
		assert.ok(head.lastModified);
		const result = await storage.getObject(keys[0]!);
		assert.ok(result.body);
		let downloaded = "";
		for await (const chunk of result.body as Readable)
			downloaded += Buffer.from(chunk).toString();
		assert.equal(downloaded, text);
		const signedGet = await storage.presignDownload(keys[0]!);
		const unsigned = new URL(signedGet.url);
		unsigned.search = "";
		const privateRead = await fetch(unsigned);
		await privateRead.arrayBuffer();
		assert.equal(privateRead.ok, false, "Objects must not become public");
		assert.equal(await (await fetch(signedGet.url)).text(), text);
		const signed = await storage.presignUpload(keys[1]!, {
			contentType: "text/plain",
		});
		assert.ok(
			new URL(signed.url).searchParams
				.get("X-Amz-SignedHeaders")
				?.includes("content-type"),
		);
		const mismatch = await fetch(signed.url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: text,
		});
		await mismatch.arrayBuffer();
		assert.equal(
			mismatch.ok,
			false,
			"Provider must reject mismatched signed Content-Type",
		);
		const upload = await fetch(signed.url, {
			method: signed.method,
			headers: signed.headers,
			body: text,
		});
		await upload.arrayBuffer();
		assert.equal(upload.ok, true);
		await storage.verifyUploadedObject(keys[1]!, {
			maxBytes: 100,
			contentType: "text/plain",
		});
		await assert.rejects(
			storage.verifyUploadedObject(keys[1]!, { maxBytes: 1 }),
			(e: unknown) => e instanceof StorageError && e.code === "invalid_input",
		);
		await assert.rejects(
			storage.verifyUploadedObject(keys[1]!, {
				maxBytes: 100,
				contentType: "application/json",
			}),
			StorageError,
		);
		await assert.rejects(
			storage.verifyUploadedObject(keys[0]!, {
				maxBytes: 100,
				metadata: { purpose: "wrong" },
			}),
			StorageError,
		);
		const listed: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await storage.listObjects({ prefix, limit: 1, cursor });
			listed.push(...page.objects.map((o) => o.key!));
			cursor = page.cursor;
		} while (cursor);
		assert.deepEqual(listed.sort(), keys.slice(0, 2).sort());
		const multi = await storage.createMultipartUpload(keys[2]!, {
			contentType: "application/octet-stream",
			metadata: { purpose: "multipart" },
		});
		uploads.set(keys[2]!, multi.uploadId);
		const parts = [];
		const first = Buffer.alloc(5 * 1024 * 1024, 97);
		const second = Buffer.from("last");
		for (const [index, body] of [first, second].entries()) {
			const part = await storage.presignMultipartPart(
				keys[2]!,
				multi.uploadId,
				index + 1,
			);
			const response = await fetch(part.url, {
				method: part.method,
				headers: part.headers,
				body,
			});
			await response.arrayBuffer();
			assert.equal(response.ok, true);
			assert.ok(response.headers.get("etag"));
			parts.push({
				partNumber: index + 1,
				etag: response.headers.get("etag")!,
			});
		}
		await storage.completeMultipartUpload(keys[2]!, multi.uploadId, parts);
		uploads.delete(keys[2]!);
		const completed = await storage.getObject(keys[2]!);
		assert.ok(completed.body);
		const hash = createHash("sha256");
		let bytes = 0;
		for await (const chunk of completed.body as Readable) {
			const data = Buffer.from(chunk);
			hash.update(data);
			bytes += data.length;
		}
		assert.equal(
			hash.digest("hex"),
			createHash("sha256").update(first).update(second).digest("hex"),
		);
		assert.equal(bytes, first.length + second.length);
		assert.equal(completed.metadata.purpose, "multipart");
		const abort = await storage.createMultipartUpload(keys[3]!);
		uploads.set(keys[3]!, abort.uploadId);
		const part = await storage.presignMultipartPart(
			keys[3]!,
			abort.uploadId,
			1,
		);
		const response = await fetch(part.url, { method: "PUT", body: "abort me" });
		await response.arrayBuffer();
		assert.equal(response.ok, true);
		await storage.abortMultipartUpload(keys[3]!, abort.uploadId);
		uploads.delete(keys[3]!);
		await assert.rejects(
			storage.getS3Client().send(
				new ListPartsCommand({
					Bucket: storageConfig().bucket,
					Key: keys[3],
					UploadId: abort.uploadId,
				}),
			),
		);
		await storage.deleteObject(keys[1]!);
		await assert.rejects(
			storage.headObject(keys[1]!),
			(e: unknown) => e instanceof StorageError && e.code === "not_found",
		);
	} finally {
		for (const [key, id] of uploads)
			await storage.abortMultipartUpload(key, id);
		for (const key of keys) await storage.deleteObject(key);
		assert.equal((await storage.listObjects({ prefix })).objects.length, 0);
	}
}
if (
	import.meta.main ||
	import.meta.url === pathToFileURL(resolve(process.argv[1] || "")).href
) {
	const storage = getStorage();
	try {
		await storageSmoke(storage);
		console.info("Storage compatibility smoke passed; smoke objects removed");
	} catch (error) {
		console.error(storageError(error).toJSON());
		process.exitCode = 1;
	} finally {
		storage.close();
	}
}
