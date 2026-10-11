import type { FileView } from "./contract";
/** Same-origin raw-body transport. Identity never comes from browser input. */
export function createFileClient(base = "/api/files") {
	async function result(response: Response): Promise<FileView> {
		if (!response.ok) throw Error("File request failed");
		return response.json();
	}
	return {
		async list(signal?: AbortSignal): Promise<FileView[]> {
			const response = await fetch(`${base}/list`, {
				signal,
				credentials: "same-origin",
				cache: "no-store",
			});
			if (!response.ok) throw Error("File request failed");
			return response.json();
		},
		async upload(file: File, idempotencyKey: string, signal: AbortSignal) {
			return result(
				await fetch(`${base}/upload`, {
					method: "POST",
					credentials: "same-origin",
					signal,
					headers: {
						"X-File-UI": "1",
						"X-File-Name": encodeURIComponent(file.name),
						"Content-Type": file.type || "application/octet-stream",
						"Idempotency-Key": idempotencyKey,
					},
					body: file,
				}),
			);
		},
		async remove(id: string) {
			return result(
				await fetch(`${base}/remove?id=${encodeURIComponent(id)}`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "X-File-UI": "1" },
				}),
			);
		},
		downloadUrl: (id: string) =>
			`${base}/download?id=${encodeURIComponent(id)}`,
	};
}
