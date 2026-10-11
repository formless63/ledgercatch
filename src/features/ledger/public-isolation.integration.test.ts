import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.DATABASE_URL)("owner and share isolation", () => {
	it("rejects foreign rule categories, retained invalid actions, connections and ungranted shares", async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const s = await import("./schema");
		const { entityShares } = await import("../sharing/schema");
		const { saveRuleForOwner } = await import("./ledger.server");
		const { applyRulesToNewOrder } = await import("./process.server");
		const { saveConnectionForOwner, listConnectionsForOwner } = await import(
			"./exports.server"
		);
		const { requireGrant, listSharedOrdersForGrantee } = await import(
			"../sharing/sharing.server"
		);
		const ids = ["owner", "other", "viewer"].map(
			(n) => `${n}-${crypto.randomUUID()}`,
		);
		const [owner, other, viewer] = ids;
		try {
			await db.insert(user).values(
				ids.map((id) => ({
					id,
					name: "Synthetic",
					email: `${id}@example.test`,
				})),
			);
			const [entity] = await db
				.insert(s.entities)
				.values({ ownerId: owner, name: "Shared business", kind: "business" })
				.returning();
			const [foreign] = await db
				.insert(s.categories)
				.values({ ownerId: other, name: "Foreign category" })
				.returning();
			const rule = {
				name: "Invalid foreign reference",
				enabled: true,
				priority: 1,
				match: "all" as const,
				conditions: [
					{ field: "source" as const, op: "equals" as const, value: "generic" },
				],
				actions: { categoryId: foreign.id },
			};
			await expect(saveRuleForOwner(owner, rule)).rejects.toThrow(
				"Unknown category",
			);
			const [order] = await db
				.insert(s.orders)
				.values({
					ownerId: owner,
					source: "generic",
					externalOrderId: "SYNTHETIC-ISOLATION",
					totalMinor: 1000,
					currency: "USD",
					entityId: entity.id,
				})
				.returning();
			await db.insert(s.rules).values({ ...rule, ownerId: owner });
			await expect(
				db.transaction((tx) => applyRulesToNewOrder(tx, owner, order.id)),
			).rejects.toThrow("Unknown category");
			expect(
				(
					await db
						.select()
						.from(s.orders)
						.where(and(eq(s.orders.id, order.id), eq(s.orders.ownerId, owner)))
				)[0].categoryId,
			).toBeNull();
			await expect(
				saveConnectionForOwner(other, {
					provider: "invoice_ninja",
					name: "Forbidden",
					entityId: entity.id,
					enabled: true,
					config: { baseUrl: "https://example.test" },
				}),
			).rejects.toThrow("Unknown entity");
			expect(await listConnectionsForOwner(other)).toEqual([]);
			await db.insert(s.allocations).values({
				orderId: order.id,
				entityId: entity.id,
				amountMinor: 1000,
				currency: "USD",
			});
			await db.insert(entityShares).values({
				ownerId: owner,
				entityId: entity.id,
				granteeEmail: `${viewer}@example.test`,
				acceptedUserId: viewer,
				acceptedAt: new Date(),
			});
			const grant = await requireGrant(viewer, entity.id);
			expect((await listSharedOrdersForGrantee(grant, {})).total).toBe(1);
			await expect(requireGrant(other, entity.id)).rejects.toThrow("No access");
			await db
				.update(entityShares)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(entityShares.ownerId, owner),
						eq(entityShares.entityId, entity.id),
					),
				);
			await expect(requireGrant(viewer, entity.id)).rejects.toThrow(
				"No access",
			);
		} finally {
			await db.delete(user).where(inArray(user.id, ids));
		}
	});
});
