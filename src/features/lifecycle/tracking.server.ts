/** Periodic shipment status refresh through a tracking aggregator (#21). */
import { and, eq, gt, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db } from "#/db";
import { publishLedgerEvent } from "#/features/ledger/events.server";
import { orders, shipments } from "#/features/ledger/schema";
import { shipmentTracking } from "./schema";
import { detectCarrier, isTerminal } from "./tracking";
import {
	configuredTrackingProvider,
	type TrackingProvider,
	type TrackingQuery,
} from "./tracking-provider";

export type TrackingRefreshOptions = {
	/** Max shipments per run. */
	limit?: number;
	/** Re-check a shipment at most this often. */
	minIntervalHours?: number;
	/** Stop tracking orders older than this. */
	maxAgeDays?: number;
	ownerId?: string;
};

export async function refreshShipmentTracking(
	provider: TrackingProvider,
	options: TrackingRefreshOptions = {},
) {
	const limit = options.limit ?? 120;
	const cutoff = new Date(
		Date.now() - (options.minIntervalHours ?? 12) * 3_600_000,
	);
	const oldest = new Date(
		Date.now() - (options.maxAgeDays ?? 120) * 86_400_000,
	);
	const due = await db
		.select({
			id: shipments.id,
			orderId: shipments.orderId,
			ownerId: orders.ownerId,
			carrier: shipments.carrier,
			trackingNumber: shipments.trackingNumber,
			registeredAt: shipmentTracking.registeredAt,
			attempts: shipmentTracking.attempts,
		})
		.from(shipments)
		.innerJoin(orders, eq(orders.id, shipments.orderId))
		.leftJoin(shipmentTracking, eq(shipmentTracking.shipmentId, shipments.id))
		.where(
			and(
				isNull(shipments.deliveredAt),
				or(
					isNull(shipments.status),
					sql`lower(${shipments.status}) not in ('delivered', 'expired')`,
				),
				notInArray(orders.status, ["delivered", "cancelled", "returned"]),
				gt(orders.lastCapturedAt, oldest),
				or(
					isNull(shipmentTracking.lastCheckedAt),
					lt(shipmentTracking.lastCheckedAt, cutoff),
				),
				options.ownerId ? eq(orders.ownerId, options.ownerId) : undefined,
			),
		)
		.orderBy(sql`${shipmentTracking.lastCheckedAt} asc nulls first`)
		.limit(limit);
	if (due.length === 0) return { checked: 0, updated: 0, delivered: 0 };

	const byNumber = new Map<string, typeof due>();
	for (const row of due) {
		const key = row.trackingNumber.trim();
		byNumber.set(key, [...(byNumber.get(key) ?? []), row]);
	}
	const queries: TrackingQuery[] = [...byNumber.entries()].map(
		([number, rows]) => ({
			number,
			carrier: detectCarrier(rows[0]?.carrier, number),
		}),
	);

	let updated = 0;
	let delivered = 0;
	const touchedOwners = new Map<string, Set<string>>();
	for (let i = 0; i < queries.length; i += provider.batchSize) {
		const batch = queries.slice(i, i + provider.batchSize);
		const unregistered = batch.filter((q) =>
			(byNumber.get(q.number) ?? []).some((r) => !r.registeredAt),
		);
		let registered = new Set<string>();
		try {
			registered = new Set((await provider.register(unregistered)).accepted);
		} catch {
			// Registration failure is recorded per shipment below via fetch errors.
		}
		let results: Awaited<ReturnType<TrackingProvider["fetch"]>> = [];
		let batchError: string | null = null;
		try {
			results = await provider.fetch(batch);
		} catch (error) {
			batchError = error instanceof Error ? error.message : String(error);
		}
		const resultByNumber = new Map(results.map((r) => [r.number, r]));
		const now = new Date();
		for (const query of batch) {
			const result = resultByNumber.get(query.number);
			for (const row of byNumber.get(query.number) ?? []) {
				const trackingValues = {
					provider: provider.id,
					registeredAt:
						row.registeredAt ?? (registered.has(query.number) ? now : null),
					lastCheckedAt: now,
					lastStatus: result?.state ?? null,
					lastEventAt: result?.lastEventAt ?? null,
					lastEventText: result?.lastEventText ?? null,
					error: batchError ?? result?.error ?? (result ? null : "No result"),
					attempts: (row.attempts ?? 0) + 1,
				};
				await db
					.insert(shipmentTracking)
					.values({ shipmentId: row.id, ...trackingValues })
					.onConflictDoUpdate({
						target: shipmentTracking.shipmentId,
						set: trackingValues,
					});
				if (!result || result.state === "unknown") continue;
				const deliveredAt =
					result.state === "delivered"
						? (result.lastEventAt?.slice(0, 10) ??
							now.toISOString().slice(0, 10))
						: null;
				await db
					.update(shipments)
					.set({
						status: result.state,
						...(deliveredAt ? { deliveredAt } : {}),
						updatedAt: now,
					})
					.where(eq(shipments.id, row.id));
				updated++;
				if (isTerminal(result.state)) delivered++;
				const set = touchedOwners.get(row.ownerId) ?? new Set<string>();
				set.add(row.orderId);
				touchedOwners.set(row.ownerId, set);
			}
		}
	}
	for (const [ownerId, ids] of touchedOwners)
		publishLedgerEvent(ownerId, {
			type: "orders",
			orderIds: [...ids],
			created: 0,
		});
	return { checked: due.length, updated, delivered };
}

/** Tracking rows for an order's shipments (UI: last checked / event). */
export async function orderTrackingForOwner(ownerId: string, orderId: string) {
	const rows = await db
		.select({ tracking: shipmentTracking })
		.from(shipmentTracking)
		.innerJoin(shipments, eq(shipments.id, shipmentTracking.shipmentId))
		.innerJoin(orders, eq(orders.id, shipments.orderId))
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)))
		.then((list) => list.map((r) => r.tracking));
	return {
		enabled: configuredTrackingProvider() != null,
		shipments: rows.map((r) => ({
			...r,
			registeredAt: r.registeredAt?.toISOString() ?? null,
			lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
		})),
	};
}

/** Entry point for the job handler; no-op without TRACKING_API_KEY. */
export async function runTrackingRefresh(options: TrackingRefreshOptions = {}) {
	const provider = configuredTrackingProvider();
	if (!provider) return { skipped: "TRACKING_API_KEY not set" as const };
	return refreshShipmentTracking(provider, options);
}
