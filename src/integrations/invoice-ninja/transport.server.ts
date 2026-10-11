import { isIP } from "node:net";
import { InvoiceNinjaError } from "./errors";
import { hasControls, opaqueId, parse } from "./validation";
export const providerPin = {
	version: "5.13.43",
	commit: "382020072bc79e8c7ede49f7e9ce91b0aeb1a051",
} as const;
export type Connection = { baseUrl: string; apiToken: string };
export function validateConnection(
	value: Connection,
	environment = process.env.NODE_ENV,
): Connection {
	try {
		const u = new URL(value.baseUrl);
		const host = u.hostname.replace(/^\[|\]$/g, "");
		const authority = /^[a-z]+:\/\/([^/?#]+)/i.exec(value.baseUrl)?.[1];
		const originalHost = authority?.startsWith("[")
			? authority.slice(1, authority.indexOf("]"))
			: authority?.split(":")[0];
		const originalLiteral =
			originalHost === host && isIP(originalHost ?? "") !== 0;
		const loopback =
			originalLiteral &&
			((isIP(host) === 4 && host.split(".")[0] === "127") || host === "::1");
		if (
			value.baseUrl.includes("#") ||
			authority?.includes("@") ||
			u.username ||
			u.password ||
			u.hash ||
			u.search ||
			(u.protocol !== "https:" &&
				!(
					u.protocol === "http:" &&
					(environment === "test" || environment === "development") &&
					loopback
				))
		)
			throw 0;
		if (
			!value.apiToken ||
			hasControls(value.apiToken) ||
			Buffer.byteLength(value.apiToken) > 8192
		)
			throw 0;
		return { baseUrl: u.href.replace(/\/$/, ""), apiToken: value.apiToken };
	} catch {
		throw new InvoiceNinjaError("unconfigured");
	}
}
export function environmentConnection(): Connection {
	return validateConnection({
		baseUrl: process.env.INVOICE_NINJA_BASE_URL ?? "",
		apiToken: process.env.INVOICE_NINJA_API_TOKEN ?? "",
	});
}
export async function readBounded(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const aborted = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", aborted, { once: true });
	try {
		signal.throwIfAborted();
		for (;;) {
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new InvoiceNinjaError("limit_exceeded");
			chunks.push(next.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} finally {
		signal.removeEventListener("abort", aborted);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
/** One native request, no hidden retry. Caller cancellation remains active through body consumption. */
export async function providerRequest(
	connection: Connection,
	kind: "client" | "invoice",
	id: string,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: typeof fetch;
		environment?: string;
	} = {},
): Promise<{ status: number; body: Uint8Array }> {
	const cfg = validateConnection(connection, options.environment);
	parse(opaqueId, id);
	if (id === "." || id === "..") throw new InvoiceNinjaError("invalid_input");
	const duration = options.timeoutMs ?? 15000;
	if (!Number.isFinite(duration) || duration <= 0 || duration > 15000)
		throw new InvoiceNinjaError("invalid_input");
	const deadline = AbortSignal.timeout(duration);
	const signal = options.signal
		? AbortSignal.any([deadline, options.signal])
		: deadline;
	try {
		signal.throwIfAborted();
		const response = await (options.fetch ?? fetch)(
			`${cfg.baseUrl}/api/v1/${kind === "client" ? "clients" : "invoices"}/${encodeURIComponent(id)}`,
			{
				method: "GET",
				redirect: "error",
				signal,
				headers: {
					"X-API-TOKEN": cfg.apiToken,
					"X-Requested-With": "XMLHttpRequest",
					Accept: "application/json",
				},
			},
		);
		const body = await readBounded(response.body, 2 * 1024 * 1024, signal);
		return { status: response.status, body };
	} catch (error) {
		if (deadline.aborted) throw new InvoiceNinjaError("deadline_exceeded");
		if (options.signal?.aborted) throw new InvoiceNinjaError("cancelled");
		if (error instanceof InvoiceNinjaError) throw error;
		throw new InvoiceNinjaError("unavailable");
	}
}

/** Closed creation transport. The caller must durably mark dispatch before invoking this write. No retry. */
export async function createProviderDraft(
	connection: Connection,
	intent: import("./schema").FrozenDraft,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: typeof fetch;
		environment?: string;
	} = {},
) {
	const cfg = validateConnection(connection, options.environment);
	const duration = options.timeoutMs ?? 15000;
	if (!Number.isFinite(duration) || duration <= 0 || duration > 15000)
		throw new InvoiceNinjaError("invalid_input");
	const deadline = AbortSignal.timeout(duration);
	const signal = options.signal
		? AbortSignal.any([deadline, options.signal])
		: deadline;
	const payload = {
		client_id: intent.clientRemoteId,
		currency_id: intent.policy.currencyId,
		date: intent.input.invoiceDate,
		...(intent.input.dueDate ? { due_date: intent.input.dueDate } : {}),
		...(intent.input.numbering.mode === "explicit"
			? { number: intent.input.numbering.number }
			: {}),
		line_items: intent.input.lines.map((line) => ({
			notes: line.description,
			quantity: line.quantity,
			cost: line.unitCost,
		})),
	};
	const body = JSON.stringify(payload);
	if (Buffer.byteLength(body) > 256 * 1024)
		throw new InvoiceNinjaError("limit_exceeded");
	try {
		signal.throwIfAborted();
		const response = await (options.fetch ?? fetch)(
			`${cfg.baseUrl}/api/v1/invoices`,
			{
				method: "POST",
				body,
				signal,
				redirect: "error",
				headers: {
					"Content-Type": "application/json",
					"X-API-TOKEN": cfg.apiToken,
					"X-Requested-With": "XMLHttpRequest",
					Accept: "application/json",
				},
			},
		);
		return {
			status: response.status,
			body: await readBounded(response.body, 2 * 1024 * 1024, signal),
		};
	} catch (error) {
		if (deadline.aborted) throw new InvoiceNinjaError("deadline_exceeded");
		if (options.signal?.aborted) throw new InvoiceNinjaError("cancelled");
		if (error instanceof InvoiceNinjaError) throw error;
		throw new InvoiceNinjaError("unavailable");
	}
}
