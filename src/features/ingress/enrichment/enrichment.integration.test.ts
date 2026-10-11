/**
 * DB-backed checks for extension enrichment claims. Needs DATABASE_URL (e.g.
 * load .env.local) and applied migrations; skipped otherwise.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("enrichment claims (database)", async () => {
	const { db } = await import("#/db");
	const { user } = await import("#/db/schema");
	const { orders } = await import("#/features/ledger/schema");
	const { enrichmentTasks } = await import("../schema");
	const { claimEnrichmentTasks } = await import("./api.server");

	const ownerId = `enrichment-${crypto.randomUUID()}`;

	beforeAll(async () => {
		await db.insert(user).values({
			id: ownerId,
			name: "Enrichment",
			email: `${ownerId}@example.test`,
		});
		const rows = await db
			.insert(orders)
			.values([
				{ ownerId, source: "aliexpress", externalOrderId: "8299000000000001" },
				{ ownerId, source: "ebay", externalOrderId: "01-00000-00001" },
			])
			.returning({
				id: orders.id,
				source: orders.source,
				externalOrderId: orders.externalOrderId,
			});
		await db.insert(enrichmentTasks).values(
			rows.map((row) => ({
				ownerId,
				orderId: row.id,
				kind: "extension_fetch" as const,
				source: row.source,
				externalOrderId: row.externalOrderId,
				url:
					row.source === "ebay"
						? `https://order.ebay.com/ord/show?orderId=${row.externalOrderId}`
						: `https://www.aliexpress.com/p/order/detail.html?orderId=${row.externalOrderId}`,
			})),
		);
	});

	afterAll(async () => {
		await db
			.delete(enrichmentTasks)
			.where(eq(enrichmentTasks.ownerId, ownerId));
		await db.delete(orders).where(eq(orders.ownerId, ownerId));
		await db.delete(user).where(eq(user.id, ownerId));
	});

	it("leaves skipped sources pending without spending an attempt", async () => {
		const first = await claimEnrichmentTasks(ownerId, 5, ["aliexpress"]);
		expect(first.tasks.map((t) => t.source)).toEqual(["ebay"]);
		expect(first.pending).toBe(1);

		const [waiting] = await db
			.select({
				status: enrichmentTasks.status,
				attempts: enrichmentTasks.attempts,
			})
			.from(enrichmentTasks)
			.where(
				and(
					eq(enrichmentTasks.ownerId, ownerId),
					eq(enrichmentTasks.source, "aliexpress"),
				),
			);
		expect(waiting).toEqual({ status: "pending", attempts: 0 });

		const second = await claimEnrichmentTasks(ownerId, 5);
		expect(second.tasks.map((t) => t.source)).toEqual(["aliexpress"]);
	});
});
