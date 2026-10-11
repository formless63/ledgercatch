import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/storage.server", () => ({
	getApplicationStorage: () => ({
		createKey: () => `synthetic-documents/${crypto.randomUUID()}`,
		putObject: vi.fn().mockResolvedValue(undefined),
	}),
}));
vi.mock("./outbound.server", () => ({ afterDocument: vi.fn() }));

describe.skipIf(!process.env.DATABASE_URL)(
	"unresolved Mouser invoice review (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { auditEvents } = await import("#/integrations/audit-log/schema");
		const { captures, documents, orders } = await import("./schema");
		const { storeUploadedDocument } = await import("./documents.server");
		const { queueUnresolvedMouserInvoiceForOwner } = await import(
			"./unresolved-documents.server"
		);
		const {
			attachDocumentCaptureForOwner,
			getDocumentReviewForOwner,
			listDocumentQueueForOwner,
		} = await import("#/features/ingress/documents/review-ui.server");
		const ownerId = `invoice-review-${crypto.randomUUID()}`;
		const otherId = `invoice-review-other-${crypto.randomUUID()}`;
		const invoiceNumber = "10005555";
		const webOrderNumber = "12345678";
		const meta = {
			source: "mouser",
			kind: "invoice",
			fileName: "mouser-invoice.pdf",
			originUrl: `https://www.mouser.com/account/invoices/detail/${invoiceNumber}/pdf?hashId=SYNTHETIC`,
		} as const;
		beforeAll(async () => {
			await db.insert(user).values(
				[ownerId, otherId].map((id) => ({
					id,
					name: "Synthetic invoice test",
					email: `${id}@example.test`,
				})),
			);
			await db.insert(orders).values([
				{ ownerId, source: "mouser", externalOrderId: invoiceNumber },
				{ ownerId, source: "mouser", externalOrderId: webOrderNumber },
				{ ownerId: otherId, source: "mouser", externalOrderId: webOrderNumber },
			]);
		});
		afterAll(async () => {
			await db.delete(auditEvents).where(eq(auditEvents.actorId, ownerId));
			await db.delete(user).where(eq(user.id, ownerId));
			await db.delete(user).where(eq(user.id, otherId));
		});
		it("queues a standalone PDF once, never guesses the invoice ID, and allows only owner-authorized attachment", async () => {
			const bytes = new TextEncoder().encode(
				"%PDF-1.7\nSynthetic standalone Mouser invoice\n%%EOF",
			);
			const uploaded = await storeUploadedDocument(
				ownerId,
				meta,
				bytes,
				"application/pdf",
			);
			expect(uploaded.orderId).toBeNull();
			const repeated = await storeUploadedDocument(
				ownerId,
				meta,
				bytes,
				"application/pdf",
			);
			expect(repeated).toMatchObject({
				id: uploaded.id,
				duplicate: true,
				orderId: null,
			});
			const related = await db
				.select()
				.from(captures)
				.where(
					and(
						eq(captures.ownerId, ownerId),
						eq(captures.documentId, uploaded.id),
					),
				);
			expect(related).toHaveLength(1);
			const capture = related[0];
			if (!capture) throw new Error("Missing invoice review capture");
			expect(capture).toMatchObject({
				kind: "document",
				source: "mouser",
				status: "needs_review",
				orderIdHints: [],
			});
			expect(capture.error).toContain(
				"invoice number is not a Web Order number",
			);
			expect(capture.bodyJson).not.toHaveProperty(
				"extraction.fields.externalOrderId",
			);
			const queue = await listDocumentQueueForOwner(ownerId, {
				view: "review",
				limit: 100,
			});
			expect(queue.rows.map((row) => row.id)).toContain(capture.id);
			expect(
				(
					await listDocumentQueueForOwner(otherId, {
						view: "review",
						limit: 100,
					})
				).rows,
			).toHaveLength(0);
			await expect(
				queueUnresolvedMouserInvoiceForOwner(otherId, uploaded.id),
			).rejects.toThrow("NOT_FOUND");
			await expect(
				getDocumentReviewForOwner(otherId, capture.id),
			).rejects.toThrow("NOT_FOUND");
			const [otherOrder] = await db
				.select()
				.from(orders)
				.where(eq(orders.ownerId, otherId));
			const [ownOrder] = await db
				.select()
				.from(orders)
				.where(
					and(
						eq(orders.ownerId, ownerId),
						eq(orders.externalOrderId, webOrderNumber),
					),
				);
			if (!otherOrder || !ownOrder) throw new Error("Missing fixture orders");
			await expect(
				attachDocumentCaptureForOwner(ownerId, {
					captureId: capture.id,
					orderId: otherOrder.id,
					documentKind: "invoice",
				}),
			).rejects.toThrow("NOT_FOUND");
			await attachDocumentCaptureForOwner(ownerId, {
				captureId: capture.id,
				orderId: ownOrder.id,
				documentKind: "invoice",
			});
			const [linked] = await db
				.select()
				.from(documents)
				.where(
					and(eq(documents.id, uploaded.id), eq(documents.ownerId, ownerId)),
				);
			expect(linked?.orderId).toBe(ownOrder.id);
			expect(
				(
					await listDocumentQueueForOwner(ownerId, {
						view: "review",
						limit: 100,
					})
				).rows,
			).toHaveLength(0);
			expect(
				(
					await listDocumentQueueForOwner(ownerId, { view: "done", limit: 100 })
				).rows.map((row) => row.id),
			).toContain(capture.id);
		});
		it("keeps known Web Order mappings attached without introducing a review capture", async () => {
			const uploaded = await storeUploadedDocument(
				ownerId,
				{ ...meta, externalOrderId: webOrderNumber },
				new TextEncoder().encode(
					"%PDF-1.7\nSynthetic known Mouser invoice\n%%EOF",
				),
				"application/pdf",
			);
			expect(uploaded.orderId).not.toBeNull();
			expect(
				await db
					.select()
					.from(captures)
					.where(
						and(
							eq(captures.ownerId, ownerId),
							eq(captures.documentId, uploaded.id),
						),
					),
			).toHaveLength(0);
		});
	},
);
