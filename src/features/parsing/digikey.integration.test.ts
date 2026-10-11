import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digikeyParser } from "./digikey";

describe.skipIf(!process.env.DATABASE_URL)(
	"DigiKey shipment merge (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { captures, orders, orderItems, shipments } = await import(
			"#/features/ledger/schema"
		);
		const { upsertParsedOrder } = await import(
			"#/features/ledger/orders.server"
		);
		const ownerId = `digikey-${crypto.randomUUID()}`;
		const otherId = `digikey-other-${crypto.randomUUID()}`;
		const captureId = crypto.randomUUID();
		const externalOrderId = "9007199254740993";
		const body = JSON.parse(
			await readFile(
				new URL("./fixtures/digikey/shipment-tracking.json", import.meta.url),
				"utf8",
			),
		);
		beforeAll(async () => {
			await db.insert(user).values(
				[ownerId, otherId].map((id) => ({
					id,
					name: "DigiKey test",
					email: `${id}@example.test`,
				})),
			);
			await db.insert(captures).values({
				id: captureId,
				ownerId,
				source: "digikey",
				kind: "api_json",
				trigger: "auto",
				pageUrl: `https://www.digikey.com/OrderHistory/ReviewOrder/${externalOrderId}`,
				capturedAt: new Date(),
				contentHash: captureId,
			});
		});
		afterAll(async () => {
			await db.delete(user).where(eq(user.id, ownerId));
			await db.delete(user).where(eq(user.id, otherId));
		});
		it("merges shipment into its existing owner's order without replacing items, totals or sibling owner", async () => {
			const result = digikeyParser.parse({
				source: "digikey",
				kind: "api_json",
				pageType: "order_detail",
				pageUrl: `https://www.digikey.com/OrderHistory/ReviewOrder/${externalOrderId}`,
				pageTitle: "",
				capturedAt: "2026-08-12T12:00:00Z",
				orderIdHints: [],
				payload: {
					type: "json",
					requestUrl:
						"https://www.digikey.com/OrderHistory/api/ShipmentTracking/TrackingInfo",
					body,
				},
			});
			if (result.outcome !== "orders" || !result.orders[0])
				throw new Error("Missing parsed shipment");
			const parsed = result.orders[0];
			const [other] = await db
				.insert(orders)
				.values({ ownerId: otherId, source: "digikey", externalOrderId })
				.returning({ id: orders.id });
			if (!other) throw new Error("Missing sibling order");
			const orderId = await db.transaction(async (tx) => {
				const baseline = await upsertParsedOrder(
					tx,
					ownerId,
					"digikey",
					{
						externalOrderId,
						currency: "USD",
						totalMinor: 1250,
						items: [
							{ title: "Synthetic resistor", quantity: 5, totalMinor: 1250 },
						],
					},
					captureId,
				);
				await upsertParsedOrder(tx, ownerId, "digikey", parsed, captureId);
				return baseline.orderId;
			});
			const [stored] = await db
				.select()
				.from(orders)
				.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
			expect(stored?.totalMinor).toBe(1250);
			expect(
				await db
					.select()
					.from(orderItems)
					.where(eq(orderItems.orderId, orderId)),
			).toHaveLength(1);
			const tracked = await db
				.select()
				.from(shipments)
				.where(eq(shipments.orderId, orderId));
			expect(tracked).toHaveLength(1);
			expect(tracked[0]).toMatchObject({
				trackingNumber: "123456789012",
				carrier: "FedEx",
				status: "Delivered",
				deliveredAt: "2026-08-12",
			});
			expect(
				await db
					.select()
					.from(shipments)
					.where(eq(shipments.orderId, other.id)),
			).toHaveLength(0);
		});
	},
);
