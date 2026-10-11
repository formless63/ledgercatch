import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Exercise the real dev database and ingest/process path without job delivery
// or outbound provider calls. The worker is invoked explicitly by this suite.
vi.mock("#/integrations/jobs/client.server", () => ({
	sendJobInTransaction: vi.fn(async () => crypto.randomUUID()),
}));
vi.mock("./outbound.server", () => ({
	emitOrderEvent: vi.fn(async () => {}),
	emitCaptureFailed: vi.fn(async () => {}),
}));

const enabled = Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)(
	"capture local date survives storage (development database)",
	async () => {
		const { db } = await import("#/db");
		const { user } = await import("#/db/schema");
		const { auditEvents } = await import("#/integrations/audit-log/schema");
		const { captures, orders } = await import("./schema");
		const { ingestCapture } = await import("./captures.server");
		const { processCapture } = await import("./process.server");
		const ownerId = `capture-date-${crypto.randomUUID()}`;
		const html = await readFile(
			new URL(
				"../parsing/fixtures/ebay/checkout-success.html",
				import.meta.url,
			),
			"utf8",
		);

		beforeAll(async () => {
			await db.insert(user).values({
				id: ownerId,
				name: "Capture date test",
				email: `${ownerId}@example.test`,
			});
		});
		afterAll(async () => {
			await db.delete(auditEvents).where(eq(auditEvents.actorId, ownerId));
			await db.delete(user).where(eq(user.id, ownerId));
		});

		it.each([
			{
				capturedAt: "2026-10-08T21:30:00.000-04:00",
				instant: "2026-10-09T01:30:00.000Z",
				date: "2026-10-08",
				externalOrderId: "01-00000-00101",
			},
			{
				capturedAt: "2026-10-09T02:00:00.000+05:30",
				instant: "2026-10-08T20:30:00.000Z",
				date: "2026-10-09",
				externalOrderId: "01-00000-00102",
			},
			{
				capturedAt: "2026-10-09T01:30:00.000Z",
				instant: "2026-10-09T01:30:00.000Z",
				date: null,
				externalOrderId: "01-00000-00103",
			},
		])("persists local day from $capturedAt through a reparse", async ({
			capturedAt,
			instant,
			date,
			externalOrderId,
		}) => {
			const captureId = crypto.randomUUID();
			const response = await ingestCapture(ownerId, {
				schemaVersion: 1,
				captureId,
				source: "ebay",
				kind: "html_snapshot",
				trigger: "passive",
				pageType: "order_confirmation",
				pageUrl: "https://pay.ebay.com/rxo?action=success",
				pageTitle: "Checkout",
				capturedAt,
				extensionVersion: "0.1.0",
				orderIdHints: [],
				payload: {
					type: "html",
					html: html.replaceAll("01-00000-00042", externalOrderId),
				},
			});
			expect(response.status).toBe("accepted");
			const [capture] = await db
				.select()
				.from(captures)
				.where(and(eq(captures.ownerId, ownerId), eq(captures.id, captureId)));
			expect(capture?.capturedAt.toISOString()).toBe(instant);
			expect(capture?.capturedLocalDate).toBe(date);
			await processCapture(captureId);
			await processCapture(captureId);
			const [order] = await db
				.select()
				.from(orders)
				.where(
					and(
						eq(orders.ownerId, ownerId),
						eq(orders.externalOrderId, externalOrderId),
					),
				);
			expect(order?.orderDate).toBe(date);
		});
	},
);
