import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./notify.server", () => ({ notifyOwner: vi.fn(async () => {}) }));
vi.mock("./webhooks.server", () => ({ emitLedgerWebhook: vi.fn() }));
vi.mock("#/features/ledger/outbound.server", () => ({
	afterClaims: vi.fn(),
	emitClaimPaid: vi.fn(),
	emitOrderEvent: vi.fn(),
}));

describe.skipIf(!process.env.DATABASE_URL)(
	"paid Invoice Ninja claims",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { claims, connections, entities } = await import(
			"#/features/ledger/schema"
		);
		const { bindings, invoices, operations } = await import(
			"#/integrations/invoice-ninja/schema"
		);
		const { invoiceNinjaClaimDrafts } = await import("./schema");
		const { syncPaidClaims } = await import("./invoice-ninja.server");
		const owner = `invoice-sync-${randomUUID()}`;
		const other = `invoice-other-${randomUUID()}`;
		const ownerIds = [owner, other];
		const bindingIds: string[] = [];
		let payer: string;
		let owing: string;
		beforeAll(async () => {
			await db.insert(user).values(
				ownerIds.map((id) => ({
					id,
					name: "Synthetic invoice owner",
					email: `${id}@example.test`,
				})),
			);
			const rows = await db
				.insert(entities)
				.values([
					{ ownerId: owner, name: "Payer", kind: "personal" },
					{ ownerId: owner, name: "Owing", kind: "business" },
				])
				.returning();
			if (!rows[0] || !rows[1]) throw new Error("Missing synthetic entities");
			payer = rows[0].id;
			owing = rows[1].id;
		});
		afterAll(async () => {
			await db
				.delete(invoiceNinjaClaimDrafts)
				.where(inArray(invoiceNinjaClaimDrafts.ownerId, ownerIds));
			await db
				.delete(operations)
				.where(inArray(operations.actorUserId, ownerIds));
			if (bindingIds.length) {
				await db
					.delete(invoices)
					.where(inArray(invoices.bindingId, bindingIds));
				await db.delete(bindings).where(inArray(bindings.id, bindingIds));
			}
			await db.delete(claims).where(eq(claims.ownerId, owner));
			await db.delete(user).where(inArray(user.id, ownerIds));
		});
		async function fixture() {
			const connectionId = randomUUID(),
				operationId = randomUUID(),
				bindingId = randomUUID(),
				claimId = randomUUID();
			bindingIds.push(bindingId);
			await db.insert(connections).values({
				id: connectionId,
				ownerId: owner,
				provider: "invoice_ninja",
				name: "Synthetic connection",
				entityId: owing,
				config: {},
			});
			await db.insert(claims).values({
				id: claimId,
				ownerId: owner,
				payerEntityId: payer,
				owingEntityId: owing,
				currency: "USD",
				status: "submitted",
				totalMinor: 100,
			});
			await db.insert(bindings).values({
				id: bindingId,
				scopeKind: "user",
				scopeId: owner,
				localResourceId: operationId,
				connectionId: `c-${connectionId}`,
				resourceKind: "invoice",
				remoteId: randomUUID(),
				createdAt: new Date(),
			});
			await db.insert(invoices).values({
				bindingId,
				status: "paid",
				syncedAt: new Date(),
				deleted: false,
			});
			await db.insert(operations).values({
				id: operationId,
				scopeKind: "user",
				scopeId: owner,
				actorUserId: owner,
				connectionId: `c-${connectionId}`,
				kind: "create_draft",
				status: "succeeded",
				bindingId,
				callerKey: randomUUID(),
				digest: "a".repeat(64),
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			await db
				.insert(invoiceNinjaClaimDrafts)
				.values({ claimId, ownerId: owner, connectionId, operationId });
			return { connectionId, operationId, bindingId, claimId };
		}
		it("accepts an empty database without a varchar/UUID operator error", async () => {
			expect(await syncPaidClaims()).toEqual({ paid: 0 });
		});
		it("leaves the draft retryable when the ledger mutation fails", async () => {
			const f = await fixture();
			const ledger = await import("#/features/ledger/ledger.server");
			const update = vi
				.spyOn(ledger, "setClaimStatusForOwner")
				.mockRejectedValueOnce(new Error("Synthetic write failure"));
			try {
				await expect(syncPaidClaims()).rejects.toThrow(
					"Synthetic write failure",
				);
				const [draft] = await db
					.select()
					.from(invoiceNinjaClaimDrafts)
					.where(eq(invoiceNinjaClaimDrafts.claimId, f.claimId));
				expect(draft?.paidSyncedAt).toBeNull();
			} finally {
				update.mockRestore();
			}
			expect(await syncPaidClaims()).toEqual({ paid: 1 });
		});
		it("marks the owning claim paid once through the succeeded operation's invoice binding", async () => {
			const f = await fixture();
			expect(await syncPaidClaims()).toEqual({ paid: 1 });
			const [claim] = await db
				.select()
				.from(claims)
				.where(eq(claims.id, f.claimId));
			expect(claim?.status).toBe("paid");
			const [draft] = await db
				.select()
				.from(invoiceNinjaClaimDrafts)
				.where(eq(invoiceNinjaClaimDrafts.claimId, f.claimId));
			expect(draft?.paidSyncedAt).toBeInstanceOf(Date);
			expect(await syncPaidClaims()).toEqual({ paid: 0 });
		});
		it.each([
			"binding owner",
			"binding connection",
			"operation owner",
			"operation connection",
			"connection owner",
			"retired binding",
			"deleted invoice",
			"unsucceeded operation",
		])("ignores a mismatched %s", async (mismatch) => {
			const f = await fixture();
			if (mismatch === "binding owner")
				await db
					.update(bindings)
					.set({ scopeId: other })
					.where(eq(bindings.id, f.bindingId));
			if (mismatch === "binding connection")
				await db
					.update(bindings)
					.set({ connectionId: `c-${randomUUID()}` })
					.where(eq(bindings.id, f.bindingId));
			if (mismatch === "operation owner")
				await db
					.update(operations)
					.set({ scopeId: other })
					.where(eq(operations.id, f.operationId));
			if (mismatch === "operation connection")
				await db
					.update(operations)
					.set({ connectionId: `c-${randomUUID()}` })
					.where(eq(operations.id, f.operationId));
			if (mismatch === "connection owner")
				await db
					.update(connections)
					.set({ ownerId: other })
					.where(eq(connections.id, f.connectionId));
			if (mismatch === "retired binding")
				await db
					.update(bindings)
					.set({ retiredAt: new Date() })
					.where(eq(bindings.id, f.bindingId));
			if (mismatch === "deleted invoice")
				await db
					.update(invoices)
					.set({ deleted: true })
					.where(eq(invoices.bindingId, f.bindingId));
			if (mismatch === "unsucceeded operation")
				await db
					.update(operations)
					.set({ status: "failed" })
					.where(eq(operations.id, f.operationId));
			expect(await syncPaidClaims()).toEqual({ paid: 0 });
			const [claim] = await db
				.select()
				.from(claims)
				.where(eq(claims.id, f.claimId));
			expect(claim?.status).toBe("submitted");
			const [draft] = await db
				.select()
				.from(invoiceNinjaClaimDrafts)
				.where(eq(invoiceNinjaClaimDrafts.claimId, f.claimId));
			expect(draft?.paidSyncedAt).toBeNull();
		});
	},
);
