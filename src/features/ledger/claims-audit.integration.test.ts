import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./outbound.server", () => ({
	afterClaims: vi.fn(),
	emitClaimPaid: vi.fn(),
	emitOrderEvent: vi.fn(),
}));

const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)(
	"claim status auditing (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { entities, orders, claims, allocations } = await import("./schema");
		const { auditEvents } = await import("#/integrations/audit-log/schema");
		const auditModule = await import("#/integrations/audit-log/audit.server");
		const { setClaimStatusForOwner } = await import("./ledger.server");
		const { emitClaimPaid } = await import("./outbound.server");
		const ownerId = `claim-audit-${crypto.randomUUID()}`;
		const otherId = `claim-other-${crypto.randomUUID()}`;
		let payerId: string;
		let owingId: string;

		beforeAll(async () => {
			await db.insert(user).values(
				[ownerId, otherId].map((id) => ({
					id,
					name: "Claim audit test",
					email: `${id}@example.test`,
				})),
			);
			const rows = await db
				.insert(entities)
				.values([
					{ ownerId, name: "Personal payer", kind: "personal" as const },
					{ ownerId, name: "Business owing", kind: "business" as const },
				])
				.returning();
			if (!rows[0] || !rows[1]) throw new Error("Missing entities");
			payerId = rows[0].id;
			owingId = rows[1].id;
		});
		afterAll(async () => {
			vi.restoreAllMocks();
			await db.delete(auditEvents).where(eq(auditEvents.actorId, ownerId));
			await db.delete(allocations).where(eq(allocations.entityId, owingId));
			await db.delete(claims).where(eq(claims.ownerId, ownerId));
			await db.delete(user).where(eq(user.id, ownerId));
			await db.delete(user).where(eq(user.id, otherId));
		});
		async function fixture() {
			const [order] = await db
				.insert(orders)
				.values({
					ownerId,
					source: "manual",
					externalOrderId: crypto.randomUUID(),
					currency: "USD",
					totalMinor: 518,
					entityId: owingId,
				})
				.returning();
			const [claim] = await db
				.insert(claims)
				.values({
					ownerId,
					payerEntityId: payerId,
					owingEntityId: owingId,
					currency: "USD",
					totalMinor: 518,
					status: "submitted",
				})
				.returning();
			if (!order || !claim) throw new Error("Missing claim fixture");
			const [allocation] = await db
				.insert(allocations)
				.values({
					orderId: order.id,
					entityId: owingId,
					amountMinor: 518,
					currency: "USD",
					reimbursable: true,
					reimbursementStatus: "submitted",
					claimId: claim.id,
				})
				.returning();
			if (!allocation) throw new Error("Missing allocation fixture");
			return { order, claim, allocation };
		}
		it("audits paid, submitted and void transitions on the claim and affected order without reference text", async () => {
			const row = await fixture();
			let previousStatus = "submitted";
			for (const status of ["paid", "submitted", "void"] as const) {
				await setClaimStatusForOwner(ownerId, {
					id: row.claim.id,
					status,
					reference: "Private reimbursement reference",
				});
				const [claim] = await db
					.select()
					.from(claims)
					.where(and(eq(claims.id, row.claim.id), eq(claims.ownerId, ownerId)));
				const [allocation] = await db
					.select()
					.from(allocations)
					.where(eq(allocations.id, row.allocation.id));
				const expected =
					status === "paid"
						? "reimbursed"
						: status === "void"
							? "pending"
							: "submitted";
				expect(claim?.status).toBe(status);
				expect(allocation?.reimbursementStatus).toBe(expected);
				expect(allocation?.claimId).toBe(
					status === "void" ? null : row.claim.id,
				);
				const events = await db
					.select()
					.from(auditEvents)
					.where(
						and(
							eq(auditEvents.actorId, ownerId),
							eq(auditEvents.subjectId, row.claim.id),
						),
					);
				expect(events.find((e) => e.metadata.status === status)).toMatchObject({
					actorType: "user",
					action: "claim.status_changed",
					subjectType: "claim",
					outcome: "success",
					metadata: {
						previousStatus,
						status,
						reimbursementStatus: expected,
						allocationCount: 1,
					},
				});
				previousStatus = status;
				expect(JSON.stringify(events)).not.toContain(
					"Private reimbursement reference",
				);
			}
			const events = await db
				.select()
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.actorId, ownerId),
						eq(auditEvents.subjectId, row.order.id),
					),
				);
			expect(events).toHaveLength(3);
			expect(
				events.every(
					(e) =>
						e.action === "order.claim_status_changed" &&
						e.metadata.allocationId === row.allocation.id,
				),
			).toBe(true);
		});
		it.each([
			"draft",
			"submitted",
			"void",
		] as const)("clears the paid timestamp on paid -> %s", async (status) => {
			const row = await fixture();
			await setClaimStatusForOwner(ownerId, {
				id: row.claim.id,
				status: "paid",
			});
			const [paid] = await db
				.select()
				.from(claims)
				.where(and(eq(claims.id, row.claim.id), eq(claims.ownerId, ownerId)));
			expect(paid?.paidAt).toBeInstanceOf(Date);
			await setClaimStatusForOwner(ownerId, { id: row.claim.id, status });
			const [unpaid] = await db
				.select()
				.from(claims)
				.where(and(eq(claims.id, row.claim.id), eq(claims.ownerId, ownerId)));
			expect(unpaid).toMatchObject({ status, paidAt: null });
			if (status === "submitted")
				expect(unpaid?.submittedAt).toBeInstanceOf(Date);
		});
		it("rejects another owner before mutation or audit", async () => {
			const row = await fixture();
			await expect(
				setClaimStatusForOwner(otherId, { id: row.claim.id, status: "paid" }),
			).rejects.toThrow("NOT_FOUND");
			const [claim] = await db
				.select()
				.from(claims)
				.where(eq(claims.id, row.claim.id));
			expect(claim?.status).toBe("submitted");
			const events = await db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.subjectId, row.claim.id));
			expect(events).toEqual([]);
		});
		it("rolls back both mutations and the first audit if the order audit fails", async () => {
			const row = await fixture();
			const original = auditModule.appendAuditEvent;
			const spy = vi
				.spyOn(auditModule, "appendAuditEvent")
				.mockImplementation(async (tx, event) => {
					if (event.action === "order.claim_status_changed")
						throw new Error("Injected audit failure");
					return original(tx, event);
				});
			vi.mocked(emitClaimPaid).mockClear();
			try {
				await expect(
					setClaimStatusForOwner(ownerId, { id: row.claim.id, status: "paid" }),
				).rejects.toThrow("Injected audit failure");
			} finally {
				spy.mockRestore();
			}
			const [claim] = await db
				.select()
				.from(claims)
				.where(eq(claims.id, row.claim.id));
			const [allocation] = await db
				.select()
				.from(allocations)
				.where(eq(allocations.id, row.allocation.id));
			expect(claim).toMatchObject({ status: "submitted", paidAt: null });
			expect(allocation).toMatchObject({
				reimbursementStatus: "submitted",
				claimId: row.claim.id,
			});
			const events = await db
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.subjectId, row.claim.id));
			expect(events).toEqual([]);
			expect(emitClaimPaid).not.toHaveBeenCalled();
		});
	},
);
