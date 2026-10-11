/**
 * Paperless-ngx push: after an invoice/receipt document is stored, queue a
 * job per Paperless source of the owner with `pushInvoices` on. Documents
 * that came from Paperless are never pushed back.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { ingressSources } from "#/features/ingress/schema";
import { paperlessConfig } from "#/features/ingress/sources/paperless.server";
import { captures, documents } from "#/features/ledger/schema";
import { paperlessPushes } from "./schema";

const PUSH_KINDS = new Set(["invoice", "receipt"]);

async function pushSources(ownerId: string) {
	const rows = await db
		.select()
		.from(ingressSources)
		.where(
			and(
				eq(ingressSources.ownerId, ownerId),
				eq(ingressSources.kind, "paperless"),
				eq(ingressSources.enabled, "on"),
			),
		);
	return rows.filter((row) => {
		try {
			return paperlessConfig(row).pushInvoices;
		} catch {
			return false;
		}
	});
}

/**
 * Call after a document row is committed. Best effort: never throws, so the
 * storing request is unaffected. Idempotent per (source, document).
 */
export async function afterDocumentStored(ownerId: string, documentId: string) {
	try {
		const [doc] = await db
			.select({
				id: documents.id,
				kind: documents.kind,
				captureChannel: captures.channel,
			})
			.from(documents)
			.leftJoin(captures, eq(captures.id, documents.captureId))
			.where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)));
		if (!doc || !PUSH_KINDS.has(doc.kind) || doc.captureChannel === "paperless")
			return { queued: 0 };
		const sources = await pushSources(ownerId);
		if (sources.length === 0) return { queued: 0 };
		const { sendJob } = await import("#/integrations/jobs/client.server");
		let queued = 0;
		for (const source of sources) {
			const [row] = await db
				.insert(paperlessPushes)
				.values({ sourceId: source.id, documentId, ownerId })
				.onConflictDoNothing()
				.returning({ sourceId: paperlessPushes.sourceId });
			if (!row) continue;
			await sendJob("paperless.push", { sourceId: source.id, documentId });
			queued += 1;
		}
		return { queued };
	} catch {
		return { queued: 0 };
	}
}

/** Job handler: upload one document to one Paperless source. */
export async function runPaperlessPush(sourceId: string, documentId: string) {
	const [push] = await db
		.select()
		.from(paperlessPushes)
		.where(
			and(
				eq(paperlessPushes.sourceId, sourceId),
				eq(paperlessPushes.documentId, documentId),
			),
		);
	if (!push || push.status === "pushed") return { skipped: true };
	const { pushDocumentToPaperless } = await import(
		"#/features/ingress/sources/paperless.server"
	);
	try {
		const { taskId } = await pushDocumentToPaperless(
			sourceId,
			documentId,
			push.ownerId,
		);
		await db
			.update(paperlessPushes)
			.set({ status: "pushed", taskId, error: null, pushedAt: new Date() })
			.where(
				and(
					eq(paperlessPushes.sourceId, sourceId),
					eq(paperlessPushes.documentId, documentId),
				),
			);
		return { taskId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(paperlessPushes)
			.set({ status: "failed", error: message.slice(0, 1000) })
			.where(
				and(
					eq(paperlessPushes.sourceId, sourceId),
					eq(paperlessPushes.documentId, documentId),
				),
			);
		throw error;
	}
}
