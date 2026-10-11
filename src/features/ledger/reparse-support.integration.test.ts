import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)(
	"reparse support (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const {
			captures,
			orderCaptures,
			orderItems,
			orders,
			entities,
			allocations,
			claims,
			connections,
			exports,
		} = await import("./schema");
		const { auditEvents } = await import("#/integrations/audit-log/schema");
		const ordersModule = await import("./orders.server");
		const { upsertParsedOrder } = ordersModule;
		const { processCapture } = await import("./process.server");
		const { listUnsupportedOrdersForOwner, deleteUnsupportedOrderForOwner } =
			await import("./reparse-support.server");
		const { mergeOrdersForOwner } = await import(
			"#/features/lifecycle/duplicates.server"
		);
		const ownerId = `reparse-${crypto.randomUUID()}`;
		const otherId = `reparse-other-${crypto.randomUUID()}`;
		const html = await readFile(
			new URL(
				"../parsing/fixtures/ebay/checkout-success.html",
				import.meta.url,
			),
			"utf8",
		);
		beforeAll(async () => {
			await db.insert(user).values(
				[ownerId, otherId].map((id) => ({
					id,
					name: "Reparse test",
					email: `${id}@example.test`,
				})),
			);
		});
		afterAll(async () => {
			await db.delete(auditEvents).where(eq(auditEvents.actorId, ownerId));
			await db.delete(user).where(eq(user.id, ownerId));
			await db.delete(user).where(eq(user.id, otherId));
		});
		async function capture(bodyText = html, source = "ebay") {
			const id = crypto.randomUUID();
			await db.insert(captures).values({
				id,
				ownerId,
				source,
				kind: "html_snapshot",
				trigger: "auto",
				pageUrl: "https://pay.ebay.com/rxo?action=success",
				pageType: "order_detail",
				capturedAt: new Date(),
				contentHash: id,
				bodyText,
			});
			return id;
		}
		async function oldOrder(
			captureId: string,
			externalOrderId: string,
			source = "ebay",
		) {
			return (
				await db.transaction((tx) =>
					upsertParsedOrder(
						tx,
						ownerId,
						source,
						{ externalOrderId, currency: "USD", totalMinor: 9714 },
						captureId,
					),
				)
			).orderId;
		}
		async function flagged(orderId: string) {
			return (await listUnsupportedOrdersForOwner(ownerId)).some(
				(order) => order.id === orderId,
			);
		}
		it("flags dropped ids after real parser replay, preserves provenance and authorizes delete/merge", async () => {
			const captureId = await capture();
			const bogus = await oldOrder(captureId, "-1");
			// Before rollout every existing link is unknown, even on a parsed capture.
			await db
				.update(orderCaptures)
				.set({ supportedByParser: null })
				.where(eq(orderCaptures.orderId, bogus));
			await db
				.update(captures)
				.set({ status: "parsed" })
				.where(eq(captures.id, captureId));
			expect(await flagged(bogus)).toBe(false);
			await processCapture(captureId);
			expect(await flagged(bogus)).toBe(true);
			expect(await listUnsupportedOrdersForOwner(otherId)).toEqual([]);
			const [link] = await db
				.select()
				.from(orderCaptures)
				.where(
					and(
						eq(orderCaptures.orderId, bogus),
						eq(orderCaptures.captureId, captureId),
					),
				);
			expect(link?.supportedByParser).toBe(false);
			const [real] = await db
				.select()
				.from(orders)
				.where(
					and(
						eq(orders.ownerId, ownerId),
						eq(orders.externalOrderId, "01-00000-00042"),
					),
				);
			if (!real) throw new Error("Expected checkout parser result");
			expect(await flagged(real.id)).toBe(false);
			await expect(
				deleteUnsupportedOrderForOwner(otherId, bogus),
			).rejects.toThrow("NOT_FOUND");
			await expect(
				deleteUnsupportedOrderForOwner(ownerId, real.id),
			).rejects.toThrow("still has parser support");
			await expect(
				mergeOrdersForOwner(otherId, real.id, bogus),
			).rejects.toThrow("NOT_FOUND");
			await mergeOrdersForOwner(ownerId, real.id, bogus);
			expect(await flagged(real.id)).toBe(false);
			expect(
				await db.select().from(orders).where(eq(orders.id, bogus)),
			).toEqual([]);
			const anotherBogus = await oldOrder(captureId, "bogus-second");
			await processCapture(captureId);
			expect(await flagged(anotherBogus)).toBe(true);
			await deleteUnsupportedOrderForOwner(ownerId, anotherBogus);
			expect(
				await db.select().from(orders).where(eq(orders.id, anotherBogus)),
			).toEqual([]);
			expect(
				await db.select().from(captures).where(eq(captures.id, captureId)),
			).toHaveLength(1);
			const [event] = await db
				.select()
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.subjectId, anotherBogus),
						eq(auditEvents.action, "order.deleted"),
					),
				);
			expect(event).toMatchObject({
				actorId: ownerId,
				metadata: { reason: "no_current_capture_support" },
			});
		});
		it("checks every capture, conservatively retains unknown/pending evidence and clears flags on renewed support", async () => {
			const a = await capture("<html><body>No purchases here</body></html>");
			const b = await capture("<html><body>No purchases here</body></html>");
			const id = await oldOrder(a, "historic-list-order");
			await oldOrder(b, "historic-list-order");
			await db
				.update(orderCaptures)
				.set({ supportedByParser: null })
				.where(eq(orderCaptures.orderId, id));
			await processCapture(a);
			expect(await flagged(id)).toBe(false);
			await processCapture(b);
			expect(await flagged(id)).toBe(true);
			// A later registry bump makes old negative evidence stale before requeue.
			await db
				.update(captures)
				.set({ parserVersion: 0 })
				.where(eq(captures.id, b));
			expect(await flagged(id)).toBe(false);
			await processCapture(b);
			expect(await flagged(id)).toBe(true);
			await db
				.update(captures)
				.set({ status: "pending" })
				.where(eq(captures.id, b));
			expect(await flagged(id)).toBe(false);
			await processCapture(b);
			expect(await flagged(id)).toBe(true);
			await db.transaction((tx) =>
				upsertParsedOrder(
					tx,
					ownerId,
					"ebay",
					{ externalOrderId: "historic-list-order", totalMinor: 9714 },
					a,
				),
			);
			expect(await flagged(id)).toBe(false);
		});
		it("unsupported parser outcomes do not invalidate earlier evidence", async () => {
			const id = await capture(html, "no-parser-test");
			const orderId = await oldOrder(
				id,
				"unsupported-example",
				"no-parser-test",
			);
			await processCapture(id);
			const [link] = await db
				.select()
				.from(orderCaptures)
				.where(eq(orderCaptures.orderId, orderId));
			expect(link?.supportedByParser).toBe(true);
			expect(await flagged(orderId)).toBe(false);
		});
		it("protects claim and export records from deletion", async () => {
			const captureId = await capture("<html></html>");
			const orderId = await oldOrder(captureId, "claimed-example");
			await processCapture(captureId);
			expect(await flagged(orderId)).toBe(true);
			const [entity] = await db
				.insert(entities)
				.values({ ownerId, name: "Claim test", kind: "business" })
				.returning();
			const [claim] = await db
				.insert(claims)
				.values({
					ownerId,
					payerEntityId: entity?.id ?? "",
					owingEntityId: entity?.id ?? "",
					currency: "USD",
				})
				.returning();
			const [allocation] = await db
				.insert(allocations)
				.values({
					orderId,
					entityId: entity?.id ?? "",
					amountMinor: 9714,
					currency: "USD",
					claimId: claim?.id,
				})
				.returning();
			await expect(
				deleteUnsupportedOrderForOwner(ownerId, orderId),
			).rejects.toThrow("reimbursement claim");
			await db
				.update(allocations)
				.set({ claimId: null })
				.where(eq(allocations.id, allocation?.id ?? ""));
			await db
				.update(allocations)
				.set({ reimbursementStatus: "reimbursed" })
				.where(eq(allocations.id, allocation?.id ?? ""));
			await expect(
				deleteUnsupportedOrderForOwner(ownerId, orderId),
			).rejects.toThrow("payment history");
			await db
				.update(allocations)
				.set({ reimbursementStatus: "none" })
				.where(eq(allocations.id, allocation?.id ?? ""));
			const [connection] = await db
				.insert(connections)
				.values({
					ownerId,
					entityId: entity?.id ?? "",
					provider: "custom_http",
					name: "Test only",
					config: {},
				})
				.returning();
			await db.insert(exports).values({
				connectionId: connection?.id ?? "",
				orderId,
				status: "sent",
			});
			await expect(
				deleteUnsupportedOrderForOwner(ownerId, orderId),
			).rejects.toThrow("accounting export history");
			expect(
				await db.select().from(orders).where(eq(orders.id, orderId)),
			).toHaveLength(1);
		});
		it("retains document and lifecycle identities until the owner merges", async () => {
			const { documents } = await import("./schema");
			const { assets, refunds, documentLinks } = await import(
				"#/features/lifecycle/schema"
			);
			const { transactionMatches, statementTransactions } = await import(
				"#/features/money/schema"
			);
			for (const history of [
				"document",
				"extra-document",
				"asset",
				"refund",
				"statement",
			]) {
				const captureId = await capture("<html></html>");
				const orderId = await oldOrder(captureId, `history-${history}`);
				await processCapture(captureId);
				if (history === "asset")
					await db
						.insert(assets)
						.values({ ownerId, orderId, name: "Test asset" });
				else if (history === "refund")
					await db
						.insert(refunds)
						.values({ ownerId, orderId, amountMinor: 100, currency: "USD" });
				else if (history === "statement") {
					const [transaction] = await db
						.insert(statementTransactions)
						.values({
							ownerId,
							postedDate: "2026-10-10",
							description: "Test only",
							amountMinor: 9714,
							currency: "USD",
							raw: {},
							hash: crypto.randomUUID(),
						})
						.returning();
					await db.insert(transactionMatches).values({
						ownerId,
						orderId,
						transactionId: transaction?.id ?? "",
						score: 1,
						reasons: [],
					});
				} else {
					const [document] = await db
						.insert(documents)
						.values({
							ownerId,
							orderId: history === "document" ? orderId : null,
							kind: "receipt",
							fileName: "synthetic.txt",
							contentType: "text/plain",
							sizeBytes: 1,
							sha256: crypto.randomUUID(),
							storageKey: "test-only",
						})
						.returning();
					if (history === "extra-document")
						await db
							.insert(documentLinks)
							.values({ documentId: document?.id ?? "", orderId });
				}
				await expect(
					deleteUnsupportedOrderForOwner(ownerId, orderId),
				).rejects.toThrow("documents, assets, refunds or statement matches");
				expect(
					await db.select().from(orders).where(eq(orders.id, orderId)),
				).toHaveLength(1);
			}
		});
		it("rolls removal back when its required audit insert fails", async () => {
			const captureId = await capture("<html></html>");
			const orderId = await oldOrder(captureId, "audit-failure");
			await processCapture(captureId);
			const audit = vi
				.spyOn(ordersModule, "audit")
				.mockRejectedValueOnce(new Error("Test audit unavailable"));
			try {
				await expect(
					deleteUnsupportedOrderForOwner(ownerId, orderId),
				).rejects.toThrow("Test audit unavailable");
				expect(
					await db.select().from(orders).where(eq(orders.id, orderId)),
				).toHaveLength(1);
				expect(await flagged(orderId)).toBe(true);
			} finally {
				audit.mockRestore();
			}
		});
		it("refuses merges that would erase statement, reimbursement or indirect asset identity", async () => {
			const { assets } = await import("#/features/lifecycle/schema");
			const { transactionMatches, statementTransactions } = await import(
				"#/features/money/schema"
			);
			const captureId = await capture("<html></html>");
			const dropId = await oldOrder(captureId, "protected-drop");
			await processCapture(captureId);
			const keepId = await oldOrder(captureId, "protected-keep");
			const [transaction] = await db
				.insert(statementTransactions)
				.values({
					ownerId,
					postedDate: "2026-10-10",
					description: "Test only",
					amountMinor: 9714,
					currency: "USD",
					raw: {},
					hash: crypto.randomUUID(),
				})
				.returning();
			const matches = await db
				.insert(transactionMatches)
				.values(
					[keepId, dropId].map((orderId) => ({
						ownerId,
						orderId,
						transactionId: transaction?.id ?? "",
						score: 1,
						reasons: [],
						status: "confirmed" as const,
					})),
				)
				.returning();
			await expect(
				mergeOrdersForOwner(otherId, keepId, dropId),
			).rejects.toThrow("NOT_FOUND");
			await expect(
				mergeOrdersForOwner(ownerId, keepId, dropId),
			).rejects.toThrow("statement matches");
			expect(
				await db
					.select()
					.from(transactionMatches)
					.where(eq(transactionMatches.transactionId, transaction?.id ?? "")),
			).toEqual(matches);
			await db
				.delete(transactionMatches)
				.where(
					and(
						eq(transactionMatches.ownerId, ownerId),
						eq(transactionMatches.transactionId, transaction?.id ?? ""),
					),
				);
			const [entity] = await db
				.insert(entities)
				.values({ ownerId, name: "Merge test", kind: "business" })
				.returning();
			for (const [orderId, reimbursementStatus] of [
				[dropId, "submitted"],
				[keepId, "reimbursed"],
			] as const) {
				const [allocation] = await db
					.insert(allocations)
					.values({
						orderId,
						entityId: entity?.id ?? "",
						amountMinor: 9714,
						currency: "USD",
						reimbursementStatus,
					})
					.returning();
				await expect(
					mergeOrdersForOwner(ownerId, keepId, dropId),
				).rejects.toThrow("payment history");
				expect(
					await db
						.select()
						.from(allocations)
						.where(eq(allocations.id, allocation?.id ?? "")),
				).toEqual([allocation]);
				await db
					.delete(allocations)
					.where(eq(allocations.id, allocation?.id ?? ""));
			}
			const [item] = await db
				.insert(orderItems)
				.values({ orderId: dropId, position: 0, title: "Asset item" })
				.returning();
			const [asset] = await db
				.insert(assets)
				.values({
					ownerId,
					orderId: null,
					orderItemId: item?.id,
					name: "Indirect asset",
				})
				.returning();
			await expect(
				deleteUnsupportedOrderForOwner(ownerId, dropId),
			).rejects.toThrow("documents, assets, refunds or statement matches");
			await expect(
				mergeOrdersForOwner(ownerId, keepId, dropId),
			).rejects.toThrow("asset is linked");
			expect(
				await db
					.select()
					.from(assets)
					.where(eq(assets.id, asset?.id ?? "")),
			).toEqual([asset]);
			expect(
				await db
					.select()
					.from(orders)
					.where(and(eq(orders.ownerId, ownerId), eq(orders.id, dropId))),
			).toHaveLength(1);
		});
	},
);
