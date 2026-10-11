import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { sendJobInTransaction } from "#/integrations/jobs/client.server";
import type { CaptureEnvelope, CaptureResponse } from "#/shared/capture";
import { captureLocalDate } from "#/shared/capture-time";
import { storeScreenshot } from "./documents.server";
import { captures } from "./schema";

/** Stable JSON for hashing: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Content identity of a capture. Page URL is included for HTML/text so two
 * identical-looking pages at different URLs stay distinct; JSON is keyed by
 * request URL + body.
 */
export function captureContentHash(envelope: CaptureEnvelope): string {
	const { payload } = envelope;
	const material =
		payload.type === "json"
			? `json\n${payload.requestUrl}\n${canonicalJson(payload.body)}`
			: payload.type === "html"
				? `html\n${envelope.pageUrl}\n${payload.html}`
				: `text\n${envelope.pageUrl}\n${payload.text}\n${payload.note ?? ""}`;
	return createHash("sha256")
		.update(`${envelope.source}\n${material}`)
		.digest("hex");
}

export async function ingestCapture(
	ownerId: string,
	envelope: CaptureEnvelope,
): Promise<CaptureResponse> {
	const contentHash = captureContentHash(envelope);
	const { payload } = envelope;

	const existing = await db
		.select({ id: captures.id, ownerId: captures.ownerId })
		.from(captures)
		.where(eq(captures.id, envelope.captureId))
		.limit(1);
	if (existing[0]) {
		if (existing[0].ownerId !== ownerId)
			throw new Error("Capture id already used by another account");
		return { captureId: envelope.captureId, status: "duplicate" };
	}
	const sameContent = await db
		.select({ id: captures.id })
		.from(captures)
		.where(
			and(eq(captures.ownerId, ownerId), eq(captures.contentHash, contentHash)),
		)
		.limit(1);
	if (sameContent[0])
		return { captureId: envelope.captureId, status: "duplicate" };

	const screenshotDocumentId =
		payload.type === "text" && payload.screenshotDataUrl
			? await storeScreenshot(ownerId, envelope, payload.screenshotDataUrl)
			: null;

	const inserted = await db.transaction(async (tx) => {
		const rows = await tx
			.insert(captures)
			.values({
				id: envelope.captureId,
				ownerId,
				source: envelope.source,
				kind: envelope.kind,
				trigger: envelope.trigger,
				pageType: envelope.pageType,
				pageUrl: envelope.pageUrl,
				pageTitle: envelope.pageTitle,
				requestUrl: payload.type === "json" ? payload.requestUrl : null,
				capturedAt: new Date(envelope.capturedAt),
				capturedLocalDate: captureLocalDate(envelope.capturedAt) ?? null,
				extensionVersion: envelope.extensionVersion,
				contentHash,
				bodyJson:
					payload.type === "json"
						? (payload.body ?? null)
						: payload.type === "text" && payload.html
							? { html: payload.html }
							: null,
				bodyText:
					payload.type === "html"
						? payload.html
						: payload.type === "text"
							? payload.text
							: null,
				note: payload.type === "text" ? (payload.note ?? null) : null,
				screenshotDocumentId,
				orderIdHints: envelope.orderIdHints,
			})
			.onConflictDoNothing()
			.returning({ id: captures.id });
		if (rows.length === 0) return false;
		await sendJobInTransaction(tx, "captures.process", {
			captureId: envelope.captureId,
		});
		return true;
	});

	return {
		captureId: envelope.captureId,
		status: inserted ? "accepted" : "duplicate",
	};
}

/** Re-queue a capture for processing (after parser fixes or manual retry). */
export async function requeueCapture(ownerId: string, captureId: string) {
	await db.transaction(async (tx) => {
		const rows = await tx
			.update(captures)
			.set({ status: "pending", error: null })
			.where(and(eq(captures.id, captureId), eq(captures.ownerId, ownerId)))
			.returning({ id: captures.id });
		if (!rows[0]) throw new Error("Capture not found");
		await sendJobInTransaction(tx, "captures.process", { captureId });
	});
}
