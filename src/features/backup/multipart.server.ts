/** Buffered S3 multipart upload sink: bounded memory (one part) for large archives. */
import { UploadPartCommand } from "@aws-sdk/client-s3";
import { storageConfig } from "#/integrations/storage/config.server";
import { getApplicationStorage } from "#/lib/storage.server";

const PART_BYTES = 8 * 1024 * 1024; // S3 minimum is 5 MiB (except the last part)

export async function openMultipartSink(key: string, contentType: string) {
	const storage = getApplicationStorage();
	const bucket = storageConfig().bucket;
	const { uploadId } = await storage.createMultipartUpload(key, {
		contentType,
	});
	const parts: { partNumber: number; etag: string }[] = [];
	let buffer: Uint8Array[] = [];
	let buffered = 0;
	let total = 0;

	async function flush() {
		if (buffered === 0) return;
		const body = Buffer.concat(buffer, buffered);
		buffer = [];
		buffered = 0;
		const partNumber = parts.length + 1;
		const result = await storage.getS3Client().send(
			new UploadPartCommand({
				Bucket: bucket,
				Key: key,
				UploadId: uploadId,
				PartNumber: partNumber,
				Body: body,
				ContentLength: body.byteLength,
			}),
		);
		if (!result.ETag) throw new Error("Upload part returned no ETag");
		parts.push({ partNumber, etag: result.ETag });
	}

	return {
		async write(chunk: Uint8Array) {
			buffer.push(chunk);
			buffered += chunk.byteLength;
			total += chunk.byteLength;
			if (buffered >= PART_BYTES) await flush();
		},
		async complete() {
			await flush();
			await storage.completeMultipartUpload(key, uploadId, parts);
			return { bytes: total };
		},
		async abort() {
			await storage.abortMultipartUpload(key, uploadId).catch(() => {});
		},
	};
}
