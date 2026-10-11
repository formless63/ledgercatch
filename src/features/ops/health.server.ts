/**
 * Pipeline health queries. Every query takes an optional ownerId: set for the
 * user-facing panel, omitted for the platform-wide Ops/Admin view. All reads
 * run inside a read-only transaction with a statement timeout.
 */
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "#/db";
import { enrichmentTasks, ingressSources } from "#/features/ingress/schema";
import { captures, connections, exports } from "#/features/ledger/schema";
import { listParsers } from "#/features/parsing/registry";
import {
	type ParserVersionStats,
	STALE_CLAIM_MINUTES,
	STUCK_SENDING_MINUTES,
} from "./health";
import { AUTO_REPARSE_KINDS } from "./reparse";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function readOnly<T>(
	fn: (tx: Tx) => Promise<T>,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
	if (options.signal?.aborted) throw new Error("aborted");
	const timeout = Math.max(100, Math.min(10_000, options.timeoutMs ?? 2000));
	return db.transaction(async (tx) => {
		await tx.execute(sql`set transaction read only`);
		await tx.execute(sql.raw(`set local statement_timeout = ${timeout}`));
		return fn(tx);
	});
}

const int = (expr: ReturnType<typeof sql>) => sql<number>`(${expr})::int`;
const since = (hours: number) =>
	sql`now() - make_interval(hours => ${hours}::int)`;

export async function capturesByStatusSource(tx: Tx, ownerId?: string) {
	return tx
		.select({
			source: captures.source,
			status: captures.status,
			last24h: int(
				sql`count(*) filter (where ${captures.receivedAt} > ${since(24)})`,
			),
			last7d: int(sql`count(*)`),
		})
		.from(captures)
		.where(
			and(
				gt(captures.receivedAt, since(24 * 7)),
				ownerId ? eq(captures.ownerId, ownerId) : undefined,
			),
		)
		.groupBy(captures.source, captures.status);
}

export async function parserStats(
	tx: Tx,
	ownerId?: string,
): Promise<ParserVersionStats[]> {
	const rows = await tx
		.select({
			parserId: captures.parserId,
			parserVersion: captures.parserVersion,
			total: int(sql`count(*)`),
			failed: int(sql`count(*) filter (where ${captures.status} = 'failed')`),
			noOrders: int(
				sql`count(*) filter (where ${captures.status} = 'no_orders')`,
			),
			needsReview: int(
				sql`count(*) filter (where ${captures.status} = 'needs_review')`,
			),
		})
		.from(captures)
		.where(
			and(
				isNotNull(captures.parserId),
				gt(captures.parsedAt, since(24 * 7)),
				ownerId ? eq(captures.ownerId, ownerId) : undefined,
			),
		)
		.groupBy(captures.parserId, captures.parserVersion)
		.orderBy(captures.parserId, captures.parserVersion);
	return rows.map((r) => ({ ...r, parserId: r.parserId ?? "none" }));
}

/** Captures parsed by an older version of a registry parser, per parser. */
export async function outdatedByParser(tx: Tx, ownerId?: string) {
	const parsers = listParsers();
	if (parsers.length === 0) return [];
	const current = sql`case ${captures.parserId} ${sql.join(
		parsers.map((p) => sql`when ${p.source} then ${p.version}::int`),
		sql` `,
	)} end`;
	const autoKinds = sql.join(
		AUTO_REPARSE_KINDS.map((k) => sql`${k}`),
		sql`, `,
	);
	return tx
		.select({
			parserId: sql<string>`${captures.parserId}`,
			currentVersion: int(current),
			outdated: int(sql`count(*)`),
			autoEligible: int(
				sql`count(*) filter (where ${captures.kind} in (${autoKinds}))`,
			),
		})
		.from(captures)
		.where(
			and(
				inArray(
					captures.parserId,
					parsers.map((p) => p.source as string),
				),
				sql`${captures.status} <> 'ignored'`,
				sql`coalesce(${captures.parserVersion}, 0) < ${current}`,
				ownerId ? eq(captures.ownerId, ownerId) : undefined,
			),
		)
		.groupBy(captures.parserId);
}

export async function exportsByStatus(tx: Tx, ownerId?: string) {
	const stuck = sql`${exports.status} = 'sending' and ${exports.startedAt} < now() - make_interval(mins => ${STUCK_SENDING_MINUTES}::int)`;
	const base = tx
		.select({
			status: exports.status,
			n: int(sql`count(*)`),
			stuck: int(sql`count(*) filter (where ${stuck})`),
			sent24h: int(
				sql`count(*) filter (where ${exports.sentAt} > ${since(24)})`,
			),
		})
		.from(exports);
	const rows = ownerId
		? await base
				.innerJoin(connections, eq(connections.id, exports.connectionId))
				.where(eq(connections.ownerId, ownerId))
				.groupBy(exports.status)
		: await base.groupBy(exports.status);
	return rows;
}

export async function enrichmentByStatus(tx: Tx, ownerId?: string) {
	return tx
		.select({
			status: enrichmentTasks.status,
			n: int(sql`count(*)`),
			staleClaimed: int(
				sql`count(*) filter (where ${enrichmentTasks.status} = 'claimed' and ${enrichmentTasks.claimedAt} < now() - make_interval(mins => ${STALE_CLAIM_MINUTES}::int))`,
			),
		})
		.from(enrichmentTasks)
		.where(ownerId ? eq(enrichmentTasks.ownerId, ownerId) : undefined)
		.groupBy(enrichmentTasks.status);
}

export async function ingressSourceCounts(tx: Tx) {
	return tx
		.select({
			kind: ingressSources.kind,
			status: ingressSources.status,
			enabled: ingressSources.enabled,
			n: int(sql`count(*)`),
		})
		.from(ingressSources)
		.groupBy(
			ingressSources.kind,
			ingressSources.status,
			ingressSources.enabled,
		);
}

/** The owner's own sources in error (owner panel only: names and errors are theirs). */
export async function ownerIngressErrors(tx: Tx, ownerId: string) {
	const rows = await tx
		.select({
			id: ingressSources.id,
			kind: ingressSources.kind,
			name: ingressSources.name,
			lastError: ingressSources.lastError,
			lastRunAt: ingressSources.lastRunAt,
		})
		.from(ingressSources)
		.where(
			and(
				eq(ingressSources.ownerId, ownerId),
				eq(ingressSources.status, "error"),
			),
		)
		.limit(20);
	return rows.map((r) => ({
		...r,
		lastError: r.lastError ? r.lastError.slice(0, 300) : null,
		lastRunAt: r.lastRunAt?.toISOString() ?? null,
	}));
}

export async function connectionCounts(tx: Tx, ownerId?: string) {
	const [row] = await tx
		.select({
			total: int(sql`count(*)`),
			enabled: int(sql`count(*) filter (where ${connections.enabled})`),
			error: int(sql`count(*) filter (where ${connections.status} = 'error')`),
		})
		.from(connections)
		.where(ownerId ? eq(connections.ownerId, ownerId) : undefined);
	return row ?? { total: 0, enabled: 0, error: 0 };
}

export async function compactionStats(tx: Tx, ownerId?: string) {
	const isCompacted = sql`jsonb_typeof(${captures.bodyJson}) = 'object' and ${captures.bodyJson} ? 'compacted'`;
	const [row] = await tx
		.select({
			compacted: int(sql`count(*)`),
			bytes: sql<number>`coalesce(sum((${captures.bodyJson} -> 'compacted' ->> 'bytes')::bigint), 0)::float8`,
		})
		.from(captures)
		.where(
			and(isCompacted, ownerId ? eq(captures.ownerId, ownerId) : undefined),
		);
	return { compacted: row?.compacted ?? 0, bytes: Math.round(row?.bytes ?? 0) };
}
