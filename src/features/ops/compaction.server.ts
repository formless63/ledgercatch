/**
 * #23 Capture retention / compaction. Large raw bodies of old, parsed
 * captures that back orders move to object storage as gzip; the row keeps a
 * pointer in body_json (`{ compacted: { storageKey, bytes, … } }`) and
 * body_text becomes NULL. Nothing is ever deleted here. `loadCaptureBody`
 * restores the body transparently for re-parsing and raw views.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { readDocumentBytes } from "#/features/ledger/documents.server";
import { captures } from "#/features/ledger/schema";
import { storageConfig } from "#/integrations/storage/config.server";
import { getApplicationStorage } from "#/lib/storage.server";
import {
	COMPACTABLE_KINDS,
	compactedPointer,
	decodeCompactedBody,
	encodeCompactedBody,
	retentionDefaults,
} from "./retention";
import { captureRetentionSettings } from "./schema";

type BodyCarrier = { bodyJson: unknown; bodyText: string | null };

export function isCaptureCompacted(capture: { bodyJson: unknown }) {
	return compactedPointer(capture.bodyJson) !== null;
}

/**
 * Return the capture with its original body. A no-op (same object) for
 * captures that were never compacted, so it is cheap to call everywhere a
 * body is read: processCapture before runParser, getCaptureForOwner, fixture
 * download, AI re-extraction.
 */
export async function loadCaptureBody<T extends BodyCarrier>(
	capture: T,
): Promise<T> {
	const pointer = compactedPointer(capture.bodyJson);
	if (!pointer) return capture;
	const gzip = await readDocumentBytes(pointer.storageKey);
	if (pointer.sha256) {
		const digest = createHash("sha256").update(gzip).digest("hex");
		if (digest !== pointer.sha256)
			throw new Error("Compacted capture body failed its integrity check");
	}
	const body = decodeCompactedBody(gzip);
	return { ...capture, bodyText: body.bodyText, bodyJson: body.bodyJson };
}

function storageReady() {
	try {
		storageConfig();
		return true;
	} catch {
		return false;
	}
}

const notCompacted = sql`not coalesce(jsonb_typeof(${captures.bodyJson}) = 'object' and ${captures.bodyJson} ? 'compacted', false)`;

/** Candidates: parsed, backing at least one order, older than the owner's retention, large. Oldest first. */
async function findCandidates(limit: number) {
	const d = retentionDefaults();
	const s = captureRetentionSettings;
	const kinds = sql.join(
		COMPACTABLE_KINDS.map((k) => sql`${k}`),
		sql`, `,
	);
	return db
		.select({ id: captures.id })
		.from(captures)
		.leftJoin(s, eq(s.ownerId, captures.ownerId))
		.where(
			and(
				eq(captures.status, "parsed"),
				sql`${captures.ordersFound} > 0`,
				sql`${captures.kind} in (${kinds})`,
				sql`coalesce(${s.compactionEnabled}, ${d.enabled})`,
				sql`${captures.receivedAt} < now() - make_interval(days => coalesce(${s.keepRawDays}, ${d.keepRawDays})::int)`,
				notCompacted,
				// octet_length(text) reads the TOAST header only; jsonb uses stored size.
				sql`coalesce(octet_length(${captures.bodyText}), 0) + coalesce(pg_column_size(${captures.bodyJson}), 0) > coalesce(${s.compactMinBytes}, ${d.compactMinBytes})`,
				sql`exists (select 1 from order_captures oc where oc.capture_id = ${captures.id})`,
			),
		)
		.orderBy(captures.receivedAt)
		.limit(limit);
}

async function compactOne(captureId: string): Promise<number> {
	const [row] = await db
		.select({
			id: captures.id,
			ownerId: captures.ownerId,
			bodyText: captures.bodyText,
			bodyJson: captures.bodyJson,
		})
		.from(captures)
		.where(eq(captures.id, captureId));
	if (!row || compactedPointer(row.bodyJson)) return 0;
	const { gzip, bytes } = encodeCompactedBody(row);
	const storage = getApplicationStorage();
	const storageKey = storage.createKey(`captures/${row.ownerId}`);
	await storage.putObject(storageKey, gzip, {
		contentType: "application/gzip",
		contentLength: gzip.byteLength,
	});
	const pointer = {
		storageKey,
		bytes,
		storedBytes: gzip.byteLength,
		sha256: createHash("sha256").update(gzip).digest("hex"),
		compactedAt: new Date().toISOString(),
		v: 1 as const,
	};
	// Bodies are immutable, so guarding on "not yet compacted" is enough.
	const updated = await db
		.update(captures)
		.set({ bodyText: null, bodyJson: { compacted: pointer } })
		.where(and(eq(captures.id, captureId), notCompacted))
		.returning({ id: captures.id });
	if (updated.length === 0) {
		await storage.deleteObject(storageKey).catch(() => {});
		return 0;
	}
	return bytes;
}

/** Run from ingress.tick: compacts at most CAPTURE_COMPACT_BATCH (default 10) captures. */
export async function compactCapturesTick(limit = retentionDefaults().batch) {
	if (limit <= 0 || !storageReady()) return { compacted: 0, compactedBytes: 0 };
	const rows = await findCandidates(limit);
	let compacted = 0;
	let compactedBytes = 0;
	for (const { id } of rows) {
		try {
			const bytes = await compactOne(id);
			if (bytes > 0) {
				compacted++;
				compactedBytes += bytes;
			}
		} catch {
			// Storage hiccup: the row keeps its inline body; next tick retries.
			break;
		}
	}
	return { compacted, compactedBytes };
}
