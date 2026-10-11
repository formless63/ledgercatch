/**
 * #3 Auto-reparse on parser version bump (worker side, owner-agnostic).
 *
 * On each ingress.tick, for every registry parser (store parsers + generic)
 * requeue captures parsed by an older version of it, plus that store's
 * failed/no_orders captures not yet seen by the current version. Same
 * semantics as requeueCapture (status → pending, error cleared, one
 * captures.process job in the same transaction), bounded per tick, oldest
 * first, and tracked by a keyset cursor per (parser, version) so a capture
 * is requeued at most once per version even when its parse keeps throwing.
 *
 * Never touched: ignored or pending captures, AI-parsed captures (parser_id
 * "ai"), and capture kinds other than api_json / html_snapshot.
 */
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { retryFailedEnrichmentInTransactionForOwner } from "#/features/ingress/enrichment/retry.server";
import { enrichmentTasks } from "#/features/ingress/schema";
import { captures } from "#/features/ledger/schema";
import { listParsers } from "#/features/parsing/registry";
import { sendJobInTransaction } from "#/integrations/jobs/client.server";
import {
	AUTO_REPARSE_KINDS,
	isAutoReparseParser,
	planReparse,
	RETRY_STATUSES,
	reparseBudget,
} from "./reparse";
import { parserReparseProgress } from "./schema";

const msReceivedAt = sql`date_trunc('milliseconds', ${captures.receivedAt})`;

function candidateFilter(parser: { source: string; version: number }) {
	const byParser = eq(captures.parserId, parser.source);
	return and(
		inArray(captures.kind, [...AUTO_REPARSE_KINDS]),
		notInArray(captures.status, ["ignored", "pending"]),
		sql`coalesce(${captures.parserVersion}, 0) < ${parser.version}`,
		sql`${captures.parserId} is distinct from 'ai'`,
		parser.source === "generic"
			? // Generic failures fell through to AI; only redo what generic itself parsed.
				byParser
			: or(
					byParser,
					and(
						eq(captures.source, parser.source),
						inArray(captures.status, [...RETRY_STATUSES]),
					),
				),
	);
}

async function requeueBatch(ids: string[]) {
	let queued = 0;
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		await db.transaction(async (tx) => {
			const rows = await tx
				.update(captures)
				.set({ status: "pending", error: null })
				.where(
					and(
						inArray(captures.id, chunk),
						notInArray(captures.status, ["ignored", "pending"]),
					),
				)
				.returning({ id: captures.id });
			for (const row of rows)
				await sendJobInTransaction(tx, "captures.process", {
					captureId: row.id,
				});
			queued += rows.length;
		});
	}
	return queued;
}

export async function autoReparseTick(budget = reparseBudget()) {
	let remaining = budget;
	let requeued = 0;
	const parsers = listParsers().filter((p) => isAutoReparseParser(p.source));
	const progressRows = await db.select().from(parserReparseProgress);
	const progressById = new Map(progressRows.map((r) => [r.parserId, r]));
	for (const parser of parsers) {
		if (remaining <= 0) break;
		const step = planReparse(parser, progressById.get(parser.source));
		if (step.action === "skip") continue;
		const now = new Date();
		if (step.action === "reset")
			await db.transaction(async (tx) => {
				await tx
					.insert(parserReparseProgress)
					.values({
						parserId: parser.source,
						targetVersion: parser.version,
						startedAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: parserReparseProgress.parserId,
						set: {
							targetVersion: parser.version,
							cursorReceivedAt: null,
							cursorId: null,
							requeued: 0,
							startedAt: now,
							completedAt: null,
							updatedAt: now,
						},
					});
				const owners = await tx
					.selectDistinct({ ownerId: enrichmentTasks.ownerId })
					.from(enrichmentTasks)
					.where(
						and(
							eq(enrichmentTasks.kind, "extension_fetch"),
							eq(enrichmentTasks.source, parser.source),
							eq(enrichmentTasks.status, "failed"),
						),
					);
				for (const { ownerId } of owners)
					await retryFailedEnrichmentInTransactionForOwner(
						tx,
						ownerId,
						parser.source,
						{ type: "system", id: "parser-bump" },
					);
			});

		const cursor = step.action === "continue" ? step.cursor : null;
		const limit = remaining;
		const rows = await db
			.select({
				id: captures.id,
				receivedAt: sql<string>`${msReceivedAt}`.mapWith(
					(v: string | Date) => new Date(v),
				),
			})
			.from(captures)
			.where(
				and(
					candidateFilter(parser),
					cursor
						? sql`(${msReceivedAt}, ${captures.id}) > (${cursor.receivedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
						: undefined,
				),
			)
			.orderBy(msReceivedAt, captures.id)
			.limit(limit);
		const queued = rows.length ? await requeueBatch(rows.map((r) => r.id)) : 0;
		requeued += queued;
		remaining -= rows.length;
		const last = rows.at(-1);
		const done = rows.length < limit;
		await db
			.update(parserReparseProgress)
			.set({
				...(last
					? { cursorReceivedAt: last.receivedAt, cursorId: last.id }
					: {}),
				requeued: sql`${parserReparseProgress.requeued} + ${queued}`,
				completedAt: done ? new Date() : null,
				updatedAt: new Date(),
			})
			.where(eq(parserReparseProgress.parserId, parser.source));
	}
	return { reparseQueued: requeued };
}

/** Progress rows for the Ops/Admin detail view. */
export async function listReparseProgress() {
	return db.select().from(parserReparseProgress);
}
