import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.skipIf(!process.env.DATABASE_URL)(
	"enrichment retry (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { orders } = await import("#/features/ledger/schema");
		const { enrichmentTasks } = await import("../schema");
		const {
			retryFailedEnrichmentForOwner,
			retryFailedEnrichmentInTransactionForOwner,
		} = await import("./retry.server");
		const { claimEnrichmentTasks, recordEnrichmentResult } = await import(
			"./api.server"
		);
		const ownerId = `retry-${crypto.randomUUID()}`;
		const otherId = `retry-other-${crypto.randomUUID()}`;
		beforeAll(async () => {
			await db.insert(user).values(
				[ownerId, otherId].map((id) => ({
					id,
					name: "Retry test",
					email: `${id}@example.test`,
				})),
			);
			for (const id of [ownerId, otherId]) {
				const rows = await db
					.insert(orders)
					.values(
						Array.from({ length: 25 }, (_, i) => ({
							ownerId: id,
							source: "aliexpress",
							externalOrderId: `200000000000${String(i).padStart(4, "0")}`,
						})),
					)
					.returning();
				await db.insert(enrichmentTasks).values(
					rows.map((order) => ({
						ownerId: id,
						orderId: order.id,
						kind: "extension_fetch" as const,
						source: order.source,
						externalOrderId: order.externalOrderId,
						url: `https://www.aliexpress.com/p/order/detail.html?orderId=${order.externalOrderId}`,
						status: "failed" as const,
						attempts: 3,
						finishedAt: new Date(),
						lastError: "challenge page",
					})),
				);
			}
		});
		afterAll(async () => {
			for (const id of [ownerId, otherId])
				await db.delete(user).where(eq(user.id, id));
		});
		it("resets owner failures, preserves other owners, and drains 25 tasks in bounded batches", async () => {
			expect(await retryFailedEnrichmentForOwner(ownerId)).toEqual({
				requeued: 25,
			});
			expect(await retryFailedEnrichmentForOwner(ownerId)).toEqual({
				requeued: 0,
			});
			const other = await db
				.select()
				.from(enrichmentTasks)
				.where(eq(enrichmentTasks.ownerId, otherId));
			expect(
				other.every((row) => row.status === "failed" && row.attempts === 3),
			).toBe(true);
			const first = await claimEnrichmentTasks(ownerId, 20);
			expect(first.tasks).toHaveLength(20);
			expect(first.pending).toBe(5);
			for (const task of first.tasks)
				await recordEnrichmentResult(ownerId, task.id, {
					status: "done",
					error: "synthetic local verification",
				});
			const second = await claimEnrichmentTasks(ownerId, 20);
			expect(second.tasks).toHaveLength(5);
			expect(second.pending).toBe(0);
			for (const task of second.tasks)
				await recordEnrichmentResult(ownerId, task.id, { status: "done" });
			expect((await claimEnrichmentTasks(ownerId, 20)).tasks).toEqual([]);
		});
		it("parser-bump retries are source-limited and atomic with the caller transaction", async () => {
			await expect(
				db.transaction(async (tx) => {
					await retryFailedEnrichmentInTransactionForOwner(
						tx,
						otherId,
						"aliexpress",
						{ type: "system", id: "parser-bump" },
					);
					throw new Error("rollback");
				}),
			).rejects.toThrow("rollback");
			expect(
				await db.transaction((tx) =>
					retryFailedEnrichmentInTransactionForOwner(tx, otherId, "ebay", {
						type: "system",
						id: "parser-bump",
					}),
				),
			).toEqual({ requeued: 0 });
			const rows = await db
				.select()
				.from(enrichmentTasks)
				.where(
					and(
						eq(enrichmentTasks.ownerId, otherId),
						eq(enrichmentTasks.status, "failed"),
					),
				);
			expect(rows).toHaveLength(25);
		});
	},
);
