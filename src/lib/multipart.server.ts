import { ApiHttpError } from "#/integrations/api-platform/responses";

/** Count actual streamed bytes before the platform multipart parser allocates fields. */
export async function readMultipart(
	request: Request,
	maxBytes: number,
): Promise<FormData> {
	const tooLarge = () =>
		new ApiHttpError(
			413,
			"payload_too_large",
			"Multipart upload exceeds its byte or field limit.",
		);
	const declared = request.headers.get("content-length");
	if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
		throw tooLarge();
	if (!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
		throw new ApiHttpError(400, "bad_request", "Expected multipart/form-data.");
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		if (reader)
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				bytes += next.value.byteLength;
				if (bytes > maxBytes) {
					await reader.cancel();
					throw tooLarge();
				}
				chunks.push(next.value);
			}
	} finally {
		reader?.releaseLock();
	}
	let form: FormData;
	try {
		form = await new Response(Buffer.concat(chunks, bytes), {
			headers: {
				"content-type": request.headers.get("content-type") as string,
			},
		}).formData();
	} catch {
		throw new ApiHttpError(400, "bad_request", "Malformed multipart upload.");
	}
	let fields = 0,
		textBytes = 0;
	for (const [name, value] of form) {
		fields++;
		textBytes += new TextEncoder().encode(name).length;
		if (typeof value === "string")
			textBytes += new TextEncoder().encode(value).length;
	}
	if (fields > 30 || textBytes > 65_536) throw tooLarge();
	return form;
}
