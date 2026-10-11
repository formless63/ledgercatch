import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)(
	"queue improvements (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { captures, orders, rules, entities } = await import("./schema");
		const { upsertParsedOrder } = await import("./orders.server");
		const { loadRuleSubject, applyRulesToNewOrder } = await import(
			"./process.server"
		);
		const ownerId = `queue-${crypto.randomUUID()}`;
		const otherId = `queue-other-${crypto.randomUUID()}`;
		let captureId: string;
		let orderId: string;
		beforeAll(async () => {
			await db.insert(user).values(
				[ownerId, otherId].map((id) => ({
					id,
					name: "Queue test",
					email: `${id}@example.test`,
				})),
			);
			captureId = crypto.randomUUID();
			await db.insert(captures).values({
				id: captureId,
				ownerId,
				source: "amazon",
				kind: "html_snapshot",
				trigger: "auto",
				pageUrl: "https://www.amazon.com/your-orders/orders",
				capturedAt: new Date(),
				contentHash: captureId,
			});
		});
		afterAll(async () => {
			await db.delete(user).where(eq(user.id, ownerId));
			await db.delete(user).where(eq(user.id, otherId));
		});
		it("persists groups, preserves them on sparse merge and authorizes rule subjects", async () => {
			await db.transaction(async (tx) => {
				const first = await upsertParsedOrder(
					tx,
					ownerId,
					"amazon",
					{
						externalOrderId: "111-1000000-2000000",
						placedByGroup: "Example LLC",
						currency: "USD",
						totalMinor: 1000,
					},
					captureId,
				);
				orderId = first.orderId;
				await upsertParsedOrder(
					tx,
					ownerId,
					"amazon",
					{ externalOrderId: "111-1000000-2000000", status: "shipped" },
					captureId,
				);
			});
			expect((await loadRuleSubject(db, ownerId, orderId))?.placedByGroup).toBe(
				"Example LLC",
			);
			expect(await loadRuleSubject(db, otherId, orderId)).toBeNull();
			const [entity] = await db
				.insert(entities)
				.values({ ownerId, name: "Example LLC", kind: "business" })
				.returning();
			if (!entity) throw new Error("Missing test entity");
			await db.insert(rules).values({
				ownerId,
				name: "Group",
				conditions: [
					{ field: "placed_by_group", op: "equals", value: "example llc" },
				],
				actions: { entityId: entity.id },
			});
			await db.transaction((tx) => applyRulesToNewOrder(tx, ownerId, orderId));
			const [order] = await db
				.select()
				.from(orders)
				.where(and(eq(orders.ownerId, ownerId), eq(orders.id, orderId)));
			expect(order?.entityId).toBe(entity.id);
		});
		it("suggests only this owner's signals and accepts a rule for unassigned inbox", async () => {
			const { listRuleSuggestionsForOwner, acceptRuleSuggestionForOwner } =
				await import("./rule-suggestions.server");
			const [entity] = await db
				.select()
				.from(entities)
				.where(eq(entities.ownerId, ownerId));
			if (!entity) throw new Error("Missing entity");
			const [order] = await db
				.insert(orders)
				.values({
					ownerId,
					source: "ebay",
					externalOrderId: "12-10000-20000",
					checkoutEmailDomain: "example.test",
					shipToAddress: "1 Example St",
					currency: "USD",
					totalMinor: 2000,
				})
				.returning();
			await db.insert(rules).values({
				ownerId,
				name: "Tag only",
				conditions: [
					{
						field: "checkout_email_domain",
						op: "equals",
						value: "example.test",
					},
				],
				actions: { tags: ["tagged"] },
			});
			const suggestions = await listRuleSuggestionsForOwner(ownerId);
			expect(
				suggestions.find((c) => c.field === "checkout_email_domain"),
			).toMatchObject({ value: "example.test", matchCount: 1 });
			expect(await listRuleSuggestionsForOwner(otherId)).toEqual([]);
			await expect(
				acceptRuleSuggestionForOwner(otherId, {
					field: "checkout_email_domain",
					value: "example.test",
					entityId: entity.id,
				}),
			).rejects.toThrow();
			await acceptRuleSuggestionForOwner(ownerId, {
				field: "checkout_email_domain",
				value: "example.test",
				entityId: entity.id,
			});
			const [assigned] = await db
				.select()
				.from(orders)
				.where(
					and(eq(orders.ownerId, ownerId), eq(orders.id, order?.id ?? "")),
				);
			expect(assigned?.entityId).toBe(entity.id);
			expect(
				(await listRuleSuggestionsForOwner(ownerId)).find(
					(c) => c.field === "checkout_email_domain",
				),
			).toBeUndefined();
		});
	},
);
