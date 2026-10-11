import { createHash, timingSafeEqual } from "node:crypto";
import { InvoiceNinjaError } from "./errors";

import { readBounded } from "./transport.server";
import { hasControls, isWellFormed, opaqueId } from "./validation";
export const eventKinds = [
	"invoice-created",
	"invoice-updated",
	"invoice-sent",
	"invoice-archived",
	"invoice-deleted",
] as const;
export type EventKind = (typeof eventKinds)[number];
function secret(value: string): Uint8Array {
	const bytes = Buffer.from(value);
	if (
		bytes.length < 32 ||
		bytes.length > 256 ||
		hasControls(value) ||
		!isWellFormed(value) ||
		value.includes(",")
	)
		throw new InvoiceNinjaError("unconfigured");
	return createHash("sha256").update(bytes).digest();
}
/** Possession-secret authentication only; raw body is not cryptographically signed. No database I/O. */
export async function authenticateHint(
	request: Request,
	current: string,
	previous?: string,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ bodySHA256: string; remoteId: string }> {
	const configured = [secret(current), ...(previous ? [secret(previous)] : [])];
	const timeout = options.timeoutMs ?? 5000;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 5000)
		throw new InvoiceNinjaError("invalid_input");
	const deadline = AbortSignal.timeout(timeout);
	const signal = AbortSignal.any([
		deadline,
		request.signal,
		...(options.signal ? [options.signal] : []),
	]);
	try {
		signal.throwIfAborted();
		const header = request.headers.get("X-Invoice-Ninja-Webhook-Secret");
		if (header && Buffer.byteLength(header) > 8192)
			throw new InvoiceNinjaError("limit_exceeded");
		// Headers merges duplicates with commas. Secrets containing commas are intentionally unsupported.
		if (!header || header.includes(",") || hasControls(header))
			throw new InvoiceNinjaError("invalid_input");
		const candidate = createHash("sha256").update(header).digest();
		let valid = 0;
		for (const expected of configured)
			valid |= Number(timingSafeEqual(candidate, expected));
		if (!valid) throw new InvoiceNinjaError("invalid_input");
		const bytes = await readBounded(request.body, 1024 * 1024, signal);
		const data: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
		// Pinned WebhookSingle uses Fractal ArraySerializer: the entity is at the root.
		if (
			!data ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			!("id" in data)
		)
			throw new InvoiceNinjaError("invalid_input");
		const id = opaqueId.safeParse(data.id);
		if (!id.success) throw new InvoiceNinjaError("invalid_input");
		signal.throwIfAborted();
		return {
			bodySHA256: createHash("sha256").update(bytes).digest("hex"),
			remoteId: id.data,
		};
	} catch (error) {
		if (error instanceof InvoiceNinjaError && error.code !== "unsupported")
			throw error;
		throw new InvoiceNinjaError("invalid_input");
	}
}
