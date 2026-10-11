import { InvoiceNinjaError } from "./errors";
import { readBounded } from "./transport.server";
export function publicResponse(value: unknown, status = 200) {
	const body = JSON.stringify(value);
	if (Buffer.byteLength(body) > 256 * 1024)
		throw new InvoiceNinjaError("limit_exceeded");
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}
export function errorResponse(error: unknown) {
	const safe =
		error instanceof InvoiceNinjaError
			? error
			: new InvoiceNinjaError("unavailable");
	return publicResponse({ error: safe.public() }, safe.status);
}
export async function requestJson(request: Request) {
	const deadline = AbortSignal.timeout(5000);
	const signal = AbortSignal.any([deadline, request.signal]);
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				await readBounded(request.body, 256 * 1024, signal),
			),
		) as unknown;
	} catch (error) {
		if (error instanceof InvoiceNinjaError) throw error;
		throw new InvoiceNinjaError("invalid_input");
	}
}
