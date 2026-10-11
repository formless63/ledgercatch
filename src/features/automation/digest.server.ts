/** Daily digest: per-owner counts and the hourly scheduler entry point. */
import {
	and,
	count,
	eq,
	inArray,
	isNotNull,
	lt,
	ne,
	notExists,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import { user } from "#/db/schema";
import { enrichmentTasks } from "#/features/ingress/schema";
import {
	allocations,
	captures,
	connections,
	documents,
	entities,
	exports,
	orders,
} from "#/features/ledger/schema";
import { buildDigest, type DigestCounts, digestDue } from "./digest";
import { externalChannels, getPreferences } from "./notify.server";
import { notificationPreferences } from "./schema";

const MISSING_INVOICE_DAYS = 3;

export async function gatherDigestCounts(
	ownerId: string,
	now = new Date(),
): Promise<DigestCounts> {
	const cutoff = new Date(now.getTime() - MISSING_INVOICE_DAYS * 86_400_000);
	const [inbox, missing, pending, exportRows, captureRows, enrichment] =
		await Promise.all([
			db
				.select({ n: count() })
				.from(orders)
				.where(
					and(eq(orders.ownerId, ownerId), eq(orders.reviewState, "inbox")),
				),
			db
				.select({ n: count() })
				.from(orders)
				.where(
					and(
						eq(orders.ownerId, ownerId),
						isNotNull(orders.entityId),
						ne(orders.reviewState, "ignored"),
						ne(orders.status, "cancelled"),
						lt(orders.firstSeenAt, cutoff),
						notExists(
							db
								.select({ one: sql`1` })
								.from(documents)
								.where(
									and(
										eq(documents.orderId, orders.id),
										inArray(documents.kind, ["invoice", "receipt"]),
									),
								),
						),
					),
				),
			db
				.select({
					entityName: entities.name,
					currency: allocations.currency,
					totalMinor:
						sql<number>`coalesce(sum(${allocations.amountMinor}), 0)::bigint`.mapWith(
							Number,
						),
					count: count(),
				})
				.from(allocations)
				.innerJoin(orders, eq(orders.id, allocations.orderId))
				.innerJoin(entities, eq(entities.id, allocations.entityId))
				.where(
					and(
						eq(orders.ownerId, ownerId),
						eq(allocations.reimbursable, true),
						eq(allocations.reimbursementStatus, "pending"),
					),
				)
				.groupBy(entities.name, allocations.currency),
			db
				.select({ status: exports.status, n: count() })
				.from(exports)
				.innerJoin(connections, eq(connections.id, exports.connectionId))
				.where(
					and(
						eq(connections.ownerId, ownerId),
						inArray(exports.status, ["failed", "stale"]),
					),
				)
				.groupBy(exports.status),
			db
				.select({ status: captures.status, n: count() })
				.from(captures)
				.where(
					and(
						eq(captures.ownerId, ownerId),
						inArray(captures.status, ["failed", "needs_review"]),
					),
				)
				.groupBy(captures.status),
			db
				.select({ n: count() })
				.from(enrichmentTasks)
				.where(
					and(
						eq(enrichmentTasks.ownerId, ownerId),
						inArray(enrichmentTasks.status, ["pending", "claimed"]),
					),
				),
		]);
	const byStatus = <T extends string>(
		rows: Array<{ status: T; n: number }>,
		s: T,
	) => rows.find((row) => row.status === s)?.n ?? 0;
	return {
		inbox: inbox[0]?.n ?? 0,
		missingInvoices: missing[0]?.n ?? 0,
		pendingReimbursements: pending,
		exports: {
			failed: byStatus(exportRows, "failed"),
			stale: byStatus(exportRows, "stale"),
		},
		captures: {
			failed: byStatus(captureRows, "failed"),
			needsReview: byStatus(captureRows, "needs_review"),
		},
		enrichment: enrichment[0]?.n ?? 0,
	};
}

/** Send one owner's digest now (ignores schedule). Returns null when empty. */
export async function sendDigest(ownerId: string, now = new Date()) {
	const prefs = await getPreferences(ownerId);
	const digest = buildDigest(
		await gatherDigestCounts(ownerId, now),
		prefs.alerts,
		process.env.APP_BASE_URL,
	);
	if (!digest) return null;
	const { notifyInApplication } = await import("#/lib/notifications.server");
	const { notification } = await notifyInApplication(
		{
			recipientId: ownerId,
			type: "digest.daily",
			title: digest.title,
			body: digest.body,
			metadata: { link: "/app", items: digest.total },
		},
		externalChannels(prefs),
	);
	return notification.id;
}

/** Hourly: send digests to owners whose local digest hour has arrived. */
export async function runDueDigests(now = new Date()) {
	const owners = await db
		.select({
			id: user.id,
			digestEnabled: notificationPreferences.digestEnabled,
			digestHour: notificationPreferences.digestHour,
			timezone: notificationPreferences.timezone,
			lastDigestDate: notificationPreferences.lastDigestDate,
		})
		.from(user)
		.leftJoin(
			notificationPreferences,
			eq(notificationPreferences.ownerId, user.id),
		);
	let sent = 0;
	for (const owner of owners) {
		if (owner.digestEnabled === false) continue;
		const { due, localDate } = digestDue({
			now,
			timeZone: owner.timezone ?? "UTC",
			digestHour: owner.digestHour ?? 8,
			lastDigestDate: owner.lastDigestDate ?? null,
		});
		if (!due) continue;
		// Claim the day first so a crash never double-sends.
		await db
			.insert(notificationPreferences)
			.values({ ownerId: owner.id, lastDigestDate: localDate })
			.onConflictDoUpdate({
				target: notificationPreferences.ownerId,
				set: { lastDigestDate: localDate },
			});
		try {
			if (await sendDigest(owner.id, now)) sent += 1;
		} catch {
			/* One owner's failure must not block the others. */
		}
	}
	return { owners: owners.length, sent };
}
