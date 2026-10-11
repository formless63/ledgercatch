import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.DATABASE_URL)("public purchase lifecycle", () => {
	it("captures, parses, files, allocates and reimburses a synthetic purchase", async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const s = await import("./schema");
		const { ingestCapture } = await import("./captures.server");
		const { processCapture } = await import("./process.server");
		const {
			updateOrderForOwner,
			createClaimForOwner,
			setClaimStatusForOwner,
			getOrderForOwner,
		} = await import("./ledger.server");
		const ownerId = `lifecycle-${crypto.randomUUID()}`;
		try {
			await db.insert(user).values({
				id: ownerId,
				name: "Synthetic lifecycle",
				email: `${ownerId}@example.test`,
			});
			const [personal, business] = await db
				.insert(s.entities)
				.values([
					{ ownerId, name: "Personal", kind: "personal" },
					{ ownerId, name: "Example business", kind: "business" },
				])
				.returning();
			const [payment] = await db
				.insert(s.paymentMethods)
				.values({
					ownerId,
					label: "Synthetic card",
					last4: "4242",
					payingEntityId: personal.id,
				})
				.returning();
			const html = await readFile(
				new URL(
					"../parsing/fixtures/generic/bigcommerce-account-order.html",
					import.meta.url,
				),
				"utf8",
			);
			const captureId = crypto.randomUUID();
			const result = await ingestCapture(ownerId, {
				schemaVersion: 1,
				captureId,
				source: "generic",
				kind: "html_snapshot",
				trigger: "manual",
				pageType: "order_detail",
				pageUrl:
					"https://ridgeback.example/account.php?action=view_order&order_id=3054",
				pageTitle: "Synthetic checkout",
				capturedAt: "2026-09-01T12:00:00Z",
				extensionVersion: "0.1.0",
				orderIdHints: [],
				payload: { type: "html", html },
			});
			expect(result.status).toBe("accepted");
			await processCapture(captureId);
			const [order] = await db
				.select()
				.from(s.orders)
				.where(eq(s.orders.ownerId, ownerId));
			expect(order.reviewState).toBe("inbox");
			await updateOrderForOwner(ownerId, {
				id: order.id,
				entityId: business.id,
				paymentMethodId: payment.id,
				reviewState: "filed",
				reimbursableOverride: true,
			});
			const detail = await getOrderForOwner(ownerId, order.id);
			expect(detail.items.length).toBeGreaterThan(0);
			expect(detail.allocations).toHaveLength(1);
			expect(detail.allocations[0].amountMinor).toBe(order.totalMinor);
			const claimIds = await createClaimForOwner(ownerId, {
				allocationIds: [detail.allocations[0].id],
				reference: "SYNTHETIC-LIFECYCLE",
			});
			// The public core returns the created IDs in its response envelope.
			const claimId = claimIds.claimIds[0];
			await setClaimStatusForOwner(ownerId, { id: claimId, status: "paid" });
			const [allocation] = await db
				.select()
				.from(s.allocations)
				.where(
					and(
						eq(s.allocations.orderId, order.id),
						eq(s.allocations.entityId, business.id),
					),
				);
			expect(allocation.reimbursementStatus).toBe("reimbursed");
			expect(allocation.claimId).toBe(claimId);
		} finally {
			await db.delete(user).where(eq(user.id, ownerId));
		}
	});
});
