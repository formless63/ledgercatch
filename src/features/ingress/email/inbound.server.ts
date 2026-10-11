/**
 * Push channel: POST raw MIME to /api/inbound/email/<token>.
 *
 * The token is random (shown once at creation) and stored only as a SHA-256
 * hash in ingress_sources.push_token_hash, so lookup is by hash (no
 * secret-dependent string comparison). Accepts:
 *
 *   - raw body: message/rfc822, text/plain or application/octet-stream
 *     (Cloudflare Email Worker `message.raw`, curl from fetchmail/procmail)
 *   - multipart/form-data with `body-mime` (Mailgun Routes → URL ending in
 *     "mime"), `email` (SendGrid Inbound Parse "POST the raw, full MIME"),
 *     or a `message`/`file` part
 *   - JSON with `RawEmail` (Postmark inbound, "include raw email content")
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { getLogger } from "#/integrations/observability/runtime.server";
import { ingressSources } from "../schema";
import { ingestRawEmail } from "./ingest.server";
import { MAX_EMAIL_BYTES } from "./mime.server";

const TOKEN_PREFIX = "otin_";
const TOKEN_RE = /^otin_[A-Za-z0-9_-]{32,64}$/;
/** Multipart/JSON wrappers carry the MIME plus a little overhead. */
const MAX_REQUEST_BYTES = Math.ceil(MAX_EMAIL_BYTES * 1.4) + 256 * 1024;

export function generatePushToken(): { token: string; hash: string } {
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
	return { token, hash: hashPushToken(token) };
}

export function hashPushToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function json(status: number, body: Record<string, unknown>) {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

/** Reads the request body, aborting once it exceeds `limit` bytes. */
async function readCapped(
	request: Request,
	limit: number,
): Promise<Uint8Array | null> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function extractMime(
	bytes: Uint8Array,
	contentType: string,
): Promise<{ raw: Uint8Array } | { error: string }> {
	const enc = (value: string) => ({ raw: new TextEncoder().encode(value) });
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (type === "multipart/form-data") {
		const form = await new Response(new Uint8Array(bytes), {
			headers: { "content-type": contentType },
		}).formData();
		for (const key of ["body-mime", "email", "message", "mime", "file"]) {
			const value = form.get(key);
			if (typeof value === "string" && value.trim()) return enc(value);
			if (value instanceof Blob && value.size > 0)
				return { raw: new Uint8Array(await value.arrayBuffer()) };
		}
		return {
			error:
				"Multipart body has no raw MIME field (body-mime, email, message, file)",
		};
	}
	if (type === "application/json") {
		try {
			const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<
				string,
				unknown
			>;
			const raw = body.RawEmail ?? body.raw ?? body.mime;
			if (typeof raw === "string" && raw.trim()) return enc(raw);
		} catch {
			return { error: "Invalid JSON" };
		}
		return { error: "JSON body has no RawEmail field" };
	}
	return { raw: bytes };
}

export async function handleInboundEmail(
	request: Request,
	token: string,
): Promise<Response> {
	if (!TOKEN_RE.test(token)) return json(404, { error: "not_found" });
	const [source] = await db
		.select({
			id: ingressSources.id,
			ownerId: ingressSources.ownerId,
			enabled: ingressSources.enabled,
		})
		.from(ingressSources)
		.where(
			and(
				eq(ingressSources.pushTokenHash, hashPushToken(token)),
				eq(ingressSources.kind, "inbound_email"),
			),
		);
	if (!source) return json(404, { error: "not_found" });
	if (source.enabled !== "on")
		return json(403, { error: "disabled", message: "Source is disabled." });

	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_REQUEST_BYTES)
		return json(413, {
			error: "payload_too_large",
			limitBytes: MAX_EMAIL_BYTES,
		});
	const bytes = await readCapped(request, MAX_REQUEST_BYTES);
	if (!bytes)
		return json(413, {
			error: "payload_too_large",
			limitBytes: MAX_EMAIL_BYTES,
		});
	const extracted = await extractMime(
		bytes,
		request.headers.get("content-type") ?? "message/rfc822",
	).catch(() => ({ error: "Could not read request body" }));
	if ("error" in extracted)
		return json(400, { error: "bad_request", message: extracted.error });
	const { raw } = extracted;
	if (raw.byteLength === 0)
		return json(400, { error: "bad_request", message: "Empty body" });
	if (raw.byteLength > MAX_EMAIL_BYTES)
		return json(413, {
			error: "payload_too_large",
			limitBytes: MAX_EMAIL_BYTES,
		});

	try {
		const result = await ingestRawEmail(source.ownerId, raw, {
			via: "webhook",
			sourceId: source.id,
		});
		await db
			.update(ingressSources)
			.set({ status: "ok", lastError: null, lastRunAt: new Date() })
			.where(eq(ingressSources.id, source.id));
		return json(202, {
			captureId: result.captureId,
			status: result.created ? "accepted" : "duplicate",
			store: result.source,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		getLogger().error(
			{ err: error, sourceId: source.id },
			"ingress.inbound_email: ingest failed",
		);
		await db
			.update(ingressSources)
			.set({
				status: "error",
				lastError: message.slice(0, 2000),
				lastRunAt: new Date(),
			})
			.where(eq(ingressSources.id, source.id))
			.catch(() => {});
		return json(500, { error: "ingest_failed" });
	}
}
