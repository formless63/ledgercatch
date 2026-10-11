/** Create captures from server-side channels (email, uploads, imports, agents). */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { captures } from "#/features/ledger/schema";
import { sendJobInTransaction } from "#/integrations/jobs/client.server";
import type { CaptureChannel, ServerCaptureKind } from "./types";

export type ServerCaptureInput = {
	ownerId: string;
	channel: CaptureChannel;
	/** Idempotency key within the channel; repeats return the existing capture. */
	sourceRef: string;
	source: string;
	kind: ServerCaptureKind;
	pageType?: string;
	pageUrl?: string;
	/** For API-sourced JSON captures: the endpoint that returned the body. */
	requestUrl?: string;
	pageTitle?: string;
	capturedAt?: Date;
	bodyText?: string | null;
	bodyJson?: unknown;
	documentId?: string | null;
	note?: string | null;
	orderIdHints?: string[];
};

export async function createServerCapture(
	input: ServerCaptureInput,
): Promise<{ captureId: string; created: boolean }> {
	const [existing] = await db
		.select({ id: captures.id })
		.from(captures)
		.where(
			and(
				eq(captures.ownerId, input.ownerId),
				eq(captures.channel, input.channel),
				eq(captures.sourceRef, input.sourceRef),
			),
		);
	if (existing) return { captureId: existing.id, created: false };
	const id = randomUUID();
	const contentHash = createHash("sha256")
		.update(`${input.channel}\n${input.sourceRef}`)
		.digest("hex");
	const created = await db.transaction(async (tx) => {
		const rows = await tx
			.insert(captures)
			.values({
				id,
				ownerId: input.ownerId,
				source: input.source,
				kind: input.kind,
				trigger: input.channel === "extension" ? "passive" : "manual",
				pageType: input.pageType ?? "unknown",
				pageUrl:
					input.pageUrl ?? `${input.channel}:${input.sourceRef}`.slice(0, 2000),
				pageTitle: (input.pageTitle ?? "").slice(0, 1000),
				requestUrl: input.requestUrl ?? null,
				capturedAt: input.capturedAt ?? new Date(),
				extensionVersion: "",
				contentHash,
				bodyText: input.bodyText ?? null,
				bodyJson: input.bodyJson ?? null,
				documentId: input.documentId ?? null,
				note: input.note ?? null,
				orderIdHints: input.orderIdHints ?? [],
				channel: input.channel,
				sourceRef: input.sourceRef,
			})
			.onConflictDoNothing()
			.returning({ id: captures.id });
		if (rows.length === 0) return false;
		await sendJobInTransaction(tx, "captures.process", { captureId: id });
		return true;
	});
	if (!created) {
		const [row] = await db
			.select({ id: captures.id })
			.from(captures)
			.where(
				and(
					eq(captures.ownerId, input.ownerId),
					eq(captures.channel, input.channel),
					eq(captures.sourceRef, input.sourceRef),
				),
			);
		return { captureId: row?.id ?? id, created: false };
	}
	return { captureId: id, created: true };
}
