/**
 * "Export everything": one ZIP per request with every owner-scoped table as
 * JSON + CSV and all stored document files, written straight to object
 * storage via multipart upload (memory bounded by one part + one document).
 */
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	inArray,
	lt,
	type SQL,
} from "drizzle-orm";
import { db } from "#/db";
import { env } from "#/env";
import {
	appendAuditEvent,
	createAuditActor,
	createAuditSubject,
} from "#/integrations/audit-log/audit.server";
import { getApplicationStorage } from "#/lib/storage.server";
import { readDocumentBytes } from "../ledger/documents.server";
import {
	allocations,
	captures,
	categories,
	claims,
	connections,
	documents,
	entities,
	exports,
	orderCaptures,
	orderItems,
	orders,
	paymentMethods,
	rules,
	shipments,
} from "../ledger/schema";
import { entityShares } from "../sharing/schema";
import { recordsToCsv } from "./csv";
import { openMultipartSink } from "./multipart.server";
import { type ExportArchiveSummary, exportArchives } from "./schema";
import { createZipWriter, safeZipPath, ZipLimitError } from "./zip";

/** Archives are kept this long, then deleted lazily. */
export const EXPORT_ARCHIVE_TTL_MS = 7 * 86_400_000;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
export const EXPORT_FORMAT_VERSION = 1;

function maxArchiveBytes() {
	const raw = Number(process.env.BACKUP_EXPORT_MAX_BYTES);
	return Number.isFinite(raw) && raw > 1024 * 1024 ? raw : DEFAULT_MAX_BYTES;
}

async function auditArchive(
	actor: { type: "user" | "system"; id: string },
	action: string,
	archiveId: string,
	metadata?: Record<string, unknown>,
) {
	await appendAuditEvent(db, {
		actor: createAuditActor(actor.type, actor.id),
		action,
		subject: createAuditSubject("export_archive", archiveId),
		outcome: "success",
		metadata: metadata ?? null,
	}).catch(() => {});
}

function serializeArchive(row: typeof exportArchives.$inferSelect) {
	return {
		id: row.id,
		status: row.status,
		sizeBytes: row.sizeBytes,
		documentCount: row.documentCount,
		summary: row.summary,
		error: row.error,
		createdAt: row.createdAt.toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null,
		expiresAt: row.expiresAt?.toISOString() ?? null,
	};
}
export type ExportArchiveView = ReturnType<typeof serializeArchive>;

/* ───────────────────────── owner API ───────────────────────── */

export async function listExportArchivesForOwner(ownerId: string) {
	await expireArchivesForOwner(ownerId);
	const rows = await db
		.select()
		.from(exportArchives)
		.where(eq(exportArchives.ownerId, ownerId))
		.orderBy(desc(exportArchives.createdAt))
		.limit(10);
	return rows.map(serializeArchive);
}

async function expireArchivesForOwner(ownerId: string) {
	const stale = await db
		.select({ id: exportArchives.id, storageKey: exportArchives.storageKey })
		.from(exportArchives)
		.where(
			and(
				eq(exportArchives.ownerId, ownerId),
				eq(exportArchives.status, "ready"),
				lt(exportArchives.expiresAt, new Date()),
			),
		);
	for (const row of stale) {
		if (row.storageKey)
			await getApplicationStorage()
				.deleteObject(row.storageKey)
				.catch(() => {});
		await db
			.update(exportArchives)
			.set({ status: "expired", storageKey: null })
			.where(eq(exportArchives.id, row.id));
	}
}

type Enqueue = (name: string, payload: unknown) => Promise<unknown>;

export async function requestExportArchiveForOwner(ownerId: string) {
	const [inFlight] = await db
		.select()
		.from(exportArchives)
		.where(
			and(
				eq(exportArchives.ownerId, ownerId),
				inArray(exportArchives.status, ["queued", "running"]),
			),
		)
		.orderBy(desc(exportArchives.createdAt))
		.limit(1);
	if (
		inFlight &&
		Date.now() - inFlight.createdAt.getTime() < 2 * 60 * 60 * 1000
	)
		return serializeArchive(inFlight);
	const [row] = await db
		.insert(exportArchives)
		.values({ ownerId, status: "queued" })
		.returning();
	if (!row) throw new Error("Could not create export");
	await auditArchive(
		{ type: "user", id: ownerId },
		"backup.export_requested",
		row.id,
	);
	try {
		const { sendJob } = await import("#/integrations/jobs/client.server");
		// "backup.export" is registered by the application job registry.
		await (sendJob as unknown as Enqueue)(EXPORT_ARCHIVE_JOB, {
			archiveId: row.id,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Could not queue export";
		const [failed] = await db
			.update(exportArchives)
			.set({ status: "failed", error: message.slice(0, 500) })
			.where(eq(exportArchives.id, row.id))
			.returning();
		return serializeArchive(failed ?? row);
	}
	return serializeArchive(row);
}

export async function deleteExportArchiveForOwner(
	ownerId: string,
	archiveId: string,
) {
	const [row] = await db
		.select()
		.from(exportArchives)
		.where(
			and(
				eq(exportArchives.id, archiveId),
				eq(exportArchives.ownerId, ownerId),
			),
		);
	if (!row) throw new Error("NOT_FOUND");
	if (row.status === "running")
		throw new Error("Export is still running; delete it when it finishes.");
	if (row.storageKey)
		await getApplicationStorage()
			.deleteObject(row.storageKey)
			.catch(() => {});
	await db.delete(exportArchives).where(eq(exportArchives.id, row.id));
	await auditArchive(
		{ type: "user", id: ownerId },
		"backup.export_deleted",
		row.id,
	);
	return { ok: true as const };
}

export async function findReadyArchiveForOwner(
	ownerId: string,
	archiveId: string,
) {
	const [row] = await db
		.select()
		.from(exportArchives)
		.where(
			and(
				eq(exportArchives.id, archiveId),
				eq(exportArchives.ownerId, ownerId),
				eq(exportArchives.status, "ready"),
			),
		);
	if (!row?.storageKey) return null;
	if (row.expiresAt && row.expiresAt < new Date()) return null;
	return row;
}

/* ───────────────────────── job ───────────────────────── */

export const EXPORT_ARCHIVE_JOB = "backup.export";

/** Collect every owner-scoped table. Secrets and capture bodies are excluded. */
async function collectTables(ownerId: string) {
	const ownerOrders = db
		.select({ id: orders.id })
		.from(orders)
		.where(eq(orders.ownerId, ownerId));
	const { searchVector: _sv, ...orderColumns } = getTableColumns(orders);
	const {
		bodyJson: _bj,
		bodyText: _bt,
		...captureColumns
	} = getTableColumns(captures);
	const { secretCiphertext: _sc, ...connectionColumns } =
		getTableColumns(connections);
	const { tokenHash: _th, ...shareColumns } = getTableColumns(entityShares);
	const inOwnerOrders = (column: Parameters<typeof inArray>[0]): SQL =>
		inArray(column, ownerOrders);
	const ownerConnections = db
		.select({ id: connections.id })
		.from(connections)
		.where(eq(connections.ownerId, ownerId));

	const [
		entityRows,
		categoryRows,
		paymentMethodRows,
		ruleRows,
		orderRows,
		itemRows,
		shipmentRows,
		allocationRows,
		claimRows,
		documentRows,
		captureRows,
		orderCaptureRows,
		connectionRows,
		exportRows,
		shareRows,
	] = await Promise.all([
		db.select().from(entities).where(eq(entities.ownerId, ownerId)),
		db.select().from(categories).where(eq(categories.ownerId, ownerId)),
		db.select().from(paymentMethods).where(eq(paymentMethods.ownerId, ownerId)),
		db.select().from(rules).where(eq(rules.ownerId, ownerId)),
		db
			.select(orderColumns)
			.from(orders)
			.where(eq(orders.ownerId, ownerId))
			.orderBy(asc(orders.orderDate)),
		db
			.select()
			.from(orderItems)
			.where(inOwnerOrders(orderItems.orderId))
			.orderBy(asc(orderItems.orderId), asc(orderItems.position)),
		db.select().from(shipments).where(inOwnerOrders(shipments.orderId)),
		db.select().from(allocations).where(inOwnerOrders(allocations.orderId)),
		db.select().from(claims).where(eq(claims.ownerId, ownerId)),
		db
			.select()
			.from(documents)
			.where(eq(documents.ownerId, ownerId))
			.orderBy(asc(documents.createdAt)),
		db
			.select(captureColumns)
			.from(captures)
			.where(eq(captures.ownerId, ownerId))
			.orderBy(asc(captures.receivedAt)),
		db.select().from(orderCaptures).where(inOwnerOrders(orderCaptures.orderId)),
		db
			.select(connectionColumns)
			.from(connections)
			.where(eq(connections.ownerId, ownerId)),
		db
			.select()
			.from(exports)
			.where(inArray(exports.connectionId, ownerConnections)),
		db
			.select(shareColumns)
			.from(entityShares)
			.where(eq(entityShares.ownerId, ownerId)),
	]);
	return {
		entities: entityRows,
		categories: categoryRows,
		payment_methods: paymentMethodRows,
		rules: ruleRows,
		orders: orderRows,
		order_items: itemRows,
		shipments: shipmentRows,
		allocations: allocationRows,
		claims: claimRows,
		documents: documentRows,
		captures: captureRows,
		order_captures: orderCaptureRows,
		connections: connectionRows,
		exports: exportRows,
		entity_shares: shareRows,
	} satisfies Record<string, Record<string, unknown>[]>;
}

const PRECOMPRESSED =
	/^(image\/(jpeg|png|webp|gif|avif)|application\/(zip|gzip|x-7z|x-rar))/;

function documentPath(
	doc: {
		id: string;
		fileName: string;
		createdAt: Date;
		orderId: string | null;
	},
	order:
		| { orderDate: string | null; source: string; externalOrderId: string }
		| undefined,
) {
	const year = (order?.orderDate ?? doc.createdAt.toISOString()).slice(0, 4);
	const folder = order
		? `${order.source}_${order.externalOrderId}`.slice(0, 80)
		: "unlinked";
	return safeZipPath(
		`documents/${year}/${folder}/${doc.id.slice(0, 8)}-${doc.fileName.slice(0, 120)}`,
	);
}

const README = (appName: string, generatedAt: string) =>
	`${appName} - full data export
Generated: ${generatedAt}
Format version: ${EXPORT_FORMAT_VERSION}

data/<table>.json   every row of the table (owner-scoped), machine readable
data/<table>.csv    the same rows for spreadsheets (nested values as JSON)
documents/<year>/<store>_<order>/...   stored invoices, receipts and other files
manifest.json       row counts, document index (id -> path) and skipped files

Money columns (*_minor) are integer minor units (cents) in the row's currency.
Excluded on purpose: capture bodies (raw HTML/JSON snapshots), connector
secrets and invite token hashes. Operator backups (pg_dump + object storage)
are described in docs/BACKUP.md.
`;

export async function buildExportArchive(archiveId: string) {
	const [row] = await db
		.select()
		.from(exportArchives)
		.where(eq(exportArchives.id, archiveId));
	if (!row || row.status === "ready" || row.status === "expired")
		return { skipped: true as const };
	const ownerId = row.ownerId;
	await db
		.update(exportArchives)
		.set({ status: "running", startedAt: new Date(), error: null })
		.where(eq(exportArchives.id, archiveId));

	const storage = getApplicationStorage();
	const key = `${storage.createKey("export-archives")}.zip`;
	const sink = await openMultipartSink(key, "application/zip");
	try {
		const zip = createZipWriter((chunk) => sink.write(chunk), {
			maxBytes: maxArchiveBytes(),
		});
		const generatedAt = new Date().toISOString();
		const tables = await collectTables(ownerId);
		const counts: Record<string, number> = {};
		for (const [name, rows] of Object.entries(tables)) {
			counts[name] = rows.length;
			await zip.add(`data/${name}.json`, JSON.stringify(rows, null, 1));
			await zip.add(`data/${name}.csv`, recordsToCsv(rows));
		}

		const orderById = new Map(tables.orders.map((o) => [o.id, o]));
		const index: Array<{ id: string; path: string; orderId: string | null }> =
			[];
		const skipped: Array<{ id: string; fileName: string; reason: string }> = [];
		for (const doc of tables.documents) {
			if (!zip.fits(doc.sizeBytes + 2048)) {
				skipped.push({
					id: doc.id,
					fileName: doc.fileName,
					reason: "size_limit",
				});
				continue;
			}
			let bytes: Uint8Array;
			try {
				bytes = await readDocumentBytes(doc.storageKey);
			} catch {
				skipped.push({
					id: doc.id,
					fileName: doc.fileName,
					reason: "read_failed",
				});
				continue;
			}
			const path = documentPath(
				doc,
				doc.orderId ? orderById.get(doc.orderId) : undefined,
			);
			try {
				await zip.add(path, bytes, {
					compress: !PRECOMPRESSED.test(doc.contentType),
					modified: doc.createdAt,
				});
			} catch (error) {
				if (!(error instanceof ZipLimitError)) throw error;
				skipped.push({
					id: doc.id,
					fileName: doc.fileName,
					reason: "size_limit",
				});
				continue;
			}
			index.push({ id: doc.id, path, orderId: doc.orderId });
		}

		const summary: ExportArchiveSummary = {
			formatVersion: EXPORT_FORMAT_VERSION,
			generatedAt,
			counts,
			documents: index.length,
			skippedDocuments: skipped.length,
		};
		await zip.add(
			"manifest.json",
			JSON.stringify({ ...summary, index, skipped }, null, 1),
		);
		await zip.add("README.txt", README(env.APP_NAME, generatedAt));
		await zip.finish();
		const { bytes } = await sink.complete();
		const completedAt = new Date();
		await db
			.update(exportArchives)
			.set({
				status: "ready",
				storageKey: key,
				sizeBytes: bytes,
				documentCount: index.length,
				summary,
				completedAt,
				expiresAt: new Date(completedAt.getTime() + EXPORT_ARCHIVE_TTL_MS),
			})
			.where(eq(exportArchives.id, archiveId));
		await auditArchive(
			{ type: "system", id: "backup" },
			"backup.export_ready",
			archiveId,
			{
				ownerId,
				bytes,
				documents: index.length,
				skipped: skipped.length,
			},
		);
		return { skipped: false as const, bytes, documents: index.length };
	} catch (error) {
		await sink.abort();
		await db
			.update(exportArchives)
			.set({
				status: "failed",
				error: (error instanceof Error ? error.message : String(error)).slice(
					0,
					500,
				),
				completedAt: new Date(),
			})
			.where(eq(exportArchives.id, archiveId));
		throw error;
	}
}
