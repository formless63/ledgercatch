import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import {
	type CustomHttpConfig,
	type CustomHttpSecret,
	customHttpConfigSchema,
	customHttpSecretSchema,
	parseDefinition,
	previewExpense,
} from "./custom-http";
import {
	type ConnectorContext,
	ConnectorError,
	type ConnectorProvider,
} from "./types";

type Context = ConnectorContext<CustomHttpConfig, CustomHttpSecret>;
const endpointSchema = z
	.array(
		z
			.object({
				origin: z.url(),
				addresses: z
					.array(z.string().refine((s) => isIP(s) !== 0))
					.min(1)
					.max(8),
			})
			.strict(),
	)
	.max(30);
/** Operator-only exact origins and pinned network addresses; no user-controlled DNS or redirects. */
export function approvedAddress(origin: string): string {
	let entries: z.output<typeof endpointSchema>;
	try {
		entries = endpointSchema.parse(
			JSON.parse(process.env.CUSTOM_HTTP_ENDPOINTS ?? "[]"),
		);
	} catch {
		throw new ConnectorError(
			"validation",
			"Administrator endpoint policy is invalid",
		);
	}
	const policy = entries.find((e) => e.origin === origin);
	if (!policy)
		throw new ConnectorError(
			"validation",
			"Endpoint is not approved by the administrator",
		);
	const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) && !policy.addresses.includes(host))
		throw new ConnectorError("validation", "Endpoint address is not approved");
	return policy.addresses[0];
}
async function request(
	ctx: Context,
	method: string,
	path: string,
	body?: Buffer,
	headers: Record<string, string> = {},
) {
	const address = approvedAddress(ctx.config.baseUrl);
	const url = new URL(path, ctx.config.baseUrl);
	if (url.origin !== ctx.config.baseUrl)
		throw new ConnectorError("validation", "Operation escaped endpoint");
	if (ctx.config.auth !== "none") {
		if (!ctx.secret.token)
			throw new ConnectorError("auth", "A credential is required");
		headers[
			ctx.config.auth === "bearer" ? "Authorization" : ctx.config.authHeader
		] =
			ctx.config.auth === "bearer"
				? `Bearer ${ctx.secret.token}`
				: ctx.secret.token;
	}
	if (body && body.byteLength > 14 * 1024 * 1024)
		throw new ConnectorError("validation", "Request exceeds 14 MiB");
	// One absolute deadline covers connection, TLS and streamed response. Never return remote text.
	const signal = ctx.signal
		? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
		: AbortSignal.timeout(15_000);
	return new Promise<unknown>((resolve, reject) => {
		const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
			url,
			{
				method,
				headers: {
					...headers,
					Accept: "application/json",
					...(body ? { "Content-Length": String(body.byteLength) } : {}),
				},
				signal,
				agent: false,
				lookup: (_hostname, _options, callback) =>
					callback(null, address, isIP(address)),
			},
			(res) => {
				const status = res.statusCode ?? 0;
				if (status < 200 || status >= 300) {
					res.destroy();
					reject(
						new ConnectorError(
							status === 401 || status === 403 ? "auth" : "remote",
							`Custom HTTP returned HTTP ${status}; no remote body retained`,
							{ status, retryable: status === 429 || status >= 500 },
						),
					);
					return;
				}
				const chunks: Buffer[] = [];
				let length = 0;
				res.on("data", (chunk: Buffer) => {
					length += chunk.length;
					if (length > 1024 * 1024) {
						res.destroy(new Error("limit"));
						reject(
							new ConnectorError(
								"remote",
								"Custom HTTP response exceeded 1 MiB",
							),
						);
					} else chunks.push(chunk);
				});
				res.on("error", () =>
					reject(
						new ConnectorError("network", "Custom HTTP response interrupted", {
							retryable: true,
						}),
					),
				);
				res.on("end", () => {
					try {
						resolve(
							length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {},
						);
					} catch {
						reject(
							new ConnectorError("remote", "Custom HTTP returned invalid JSON"),
						);
					}
				});
			},
		);
		req.on("error", () =>
			reject(
				new ConnectorError(
					"network",
					"Custom HTTP request failed or timed out",
					{ retryable: true },
				),
			),
		);
		req.end(body);
	});
}
function resultId(value: unknown, path: string) {
	let current = value;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
			throw new ConnectorError(
				"remote",
				"Configured result identifier is missing; reconcile before retrying",
			);
		current = (current as Record<string, unknown>)[key];
	}
	if (
		(typeof current !== "string" && typeof current !== "number") ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(String(current))
	)
		throw new ConnectorError(
			"remote",
			"Invalid result identifier; reconcile before retrying",
		);
	return String(current);
}
export const customHttpProvider: ConnectorProvider<
	CustomHttpConfig,
	CustomHttpSecret
> = {
	id: "custom_http",
	label: "Custom HTTP",
	description:
		"Explicit HTTP operations and typed mappings. Requires administrator-approved endpoint addresses and provider-supported idempotency.",
	configSchema: customHttpConfigSchema,
	secretSchema: customHttpSecretSchema,
	configFields: [
		{ key: "baseUrl", label: "Endpoint origin", type: "url", required: true },
		{
			key: "auth",
			label: "Authentication",
			type: "select",
			options: [
				{ value: "bearer", label: "Bearer token" },
				{ value: "api_key", label: "API key header" },
				{ value: "none", label: "None" },
			],
		},
		{
			key: "authHeader",
			label: "API key header",
			type: "text",
			placeholder: "X-API-Key",
		},
		{
			key: "definition",
			label: "Operations and mappings (JSON)",
			type: "json",
			required: true,
			help: "Only confirmed idempotent writes are supported. Amounts remain exact decimal strings.",
		},
	],
	secretFields: [{ key: "token", label: "Token / API key", type: "password" }],
	async test(ctx) {
		try {
			const d = parseDefinition(ctx.config.definition);
			await request(ctx, d.test.method, d.test.path);
			return {
				ok: true,
				summary:
					"Configured read-only operation succeeded; expense writes remain unverified",
			};
		} catch (e) {
			return {
				ok: false,
				error:
					e instanceof ConnectorError ? e.message : "Invalid configuration",
			};
		}
	},
	async listOptions() {
		return { expenseAccounts: [], paymentAccounts: [] };
	},
	async pushExpense(ctx, payload) {
		const d = parseDefinition(ctx.config.definition);
		const body = Buffer.from(JSON.stringify(previewExpense(d, payload)));
		const value = await request(ctx, d.expense.method, d.expense.path, body, {
			"Content-Type": "application/json",
			[d.expense.idempotencyHeader]: payload.reference,
		});
		const remoteId = resultId(value, d.expense.resultId);
		const warnings: string[] = [];
		if (payload.documents.length && !d.attachment)
			warnings.push("Receipt attachment is not configured");
		if (d.attachment)
			for (const doc of payload.documents.slice(0, 10)) {
				try {
					if (doc.sizeBytes > d.attachment.maxBytes) throw new Error("size");
					const bytes = await doc.load();
					if (
						bytes.byteLength > d.attachment.maxBytes ||
						bytes.byteLength !== doc.sizeBytes
					)
						throw new Error("size");
					const result = await customHttpProvider.attachDocument?.(
						ctx,
						remoteId,
						{ ...doc, bytes },
					);
					if (result?.status !== "attached")
						warnings.push("Receipt was not attached");
				} catch {
					warnings.push(
						"Receipt attachment failed; expense exists. Retry the attachment after review.",
					);
				}
			}
		if (payload.documents.length > 10)
			warnings.push("Only the first 10 receipts were considered");
		return { status: "created", remoteId, warnings };
	},
	async attachDocument(ctx, remoteId, doc) {
		const d = parseDefinition(ctx.config.definition).attachment;
		if (!d)
			return { status: "skipped", reason: "Attachment is not configured" };
		if (doc.bytes.byteLength > d.maxBytes)
			return {
				status: "skipped",
				reason: "Attachment exceeds configured limit",
			};
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(remoteId))
			throw new ConnectorError("validation", "Invalid remote identifier");
		const sha = createHash("sha256").update(doc.bytes).digest("hex");
		const body = Buffer.from(
			JSON.stringify({
				[d.fileField]: Buffer.from(doc.bytes).toString("base64"),
				fileName: doc.fileName,
				contentType: doc.contentType,
				sha256: sha,
			}),
		);
		await request(
			ctx,
			d.method,
			d.path.replace("{id}", encodeURIComponent(remoteId)),
			body,
			{
				"Content-Type": "application/json",
				[d.idempotencyHeader]: `${remoteId}-${sha}`,
			},
		);
		return { status: "attached" };
	},
};
