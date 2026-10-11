/**
 * One-file-per-request upload to POST /api/import/document with progress
 * (XHR — fetch has no upload progress). Responses are classified into
 * ok / rejected (do not auto-retry) / retry (network, 5xx, signed out).
 */
import type { CaptureMeta, QueueItem, UploadOutcome } from "./queue";

export const UPLOAD_URL = "/api/import/document";
const TIMEOUT_MS = 120_000;

type ResultBody = {
	results?: Array<{
		ok: boolean;
		error?: string;
		captureId?: string;
		documentId?: string;
		created?: boolean;
	}>;
	error?: string;
};

/** Pure: map an HTTP status + parsed JSON body to a queue outcome. */
export function classifyResponse(
	status: number,
	body: ResultBody | null,
): UploadOutcome {
	if (status === 0) return { type: "retry", error: "Network unavailable" };
	if (status === 401 || status === 403)
		return {
			type: "retry",
			error: "Signed out — sign in to resume",
			auth: true,
		};
	const result = body?.results?.[0];
	if (result?.ok && result.captureId)
		return {
			type: "ok",
			captureId: result.captureId,
			documentId: result.documentId ?? null,
			duplicate: result.created === false,
		};
	if (result && !result.ok)
		return { type: "rejected", error: result.error ?? "Rejected by server" };
	if (status === 413) return { type: "rejected", error: "File too large" };
	if (status === 400)
		return { type: "rejected", error: body?.error ?? "Rejected by server" };
	return {
		type: "retry",
		error: body?.error ?? `Upload failed (HTTP ${status})`,
	};
}

/** Pure: multipart fields for one queued item. */
export function buildForm(blob: Blob, fileName: string, meta: CaptureMeta) {
	const form = new FormData();
	form.append("file", blob, fileName);
	form.append("kind", meta.kind);
	form.append("source", meta.source);
	// Not yet persisted by the upload handler (see capture-page notes); sent
	// so the server can adopt them without a client change.
	if (meta.merchantHint) form.append("merchantHint", meta.merchantHint);
	if (meta.entityId) form.append("entityId", meta.entityId);
	if (meta.note) form.append("note", meta.note);
	return form;
}

export function xhrUpload(
	item: QueueItem,
	onProgress: (fraction: number) => void,
): Promise<UploadOutcome> {
	return new Promise((resolve) => {
		if (!item.blob) {
			resolve({ type: "rejected", error: "File data missing" });
			return;
		}
		const xhr = new XMLHttpRequest();
		xhr.open("POST", UPLOAD_URL);
		xhr.timeout = TIMEOUT_MS;
		xhr.responseType = "text";
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0)
				onProgress(event.loaded / event.total);
		};
		const fail = (error: string) => resolve({ type: "retry", error });
		xhr.onerror = () => fail("Network unavailable");
		xhr.ontimeout = () => fail("Upload timed out");
		xhr.onabort = () => fail("Upload aborted");
		xhr.onload = () => {
			let body: ResultBody | null = null;
			try {
				body = JSON.parse(xhr.responseText) as ResultBody;
			} catch {
				body = null;
			}
			resolve(classifyResponse(xhr.status, body));
		};
		xhr.send(buildForm(item.blob, item.fileName, item.meta));
	});
}
