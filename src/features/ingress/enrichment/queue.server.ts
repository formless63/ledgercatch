/**
 * "Go get the rest": after a capture touched an order, decide whether the
 * order is still incomplete and queue enrichment tasks:
 *   - `extension_fetch`: the browser extension fetches the store's order
 *     detail page with the user's session (see api.server.ts);
 *   - `provider_api`: a store API source (DigiKey) fetches the order
 *     (job `enrichment.provider`, see provider.server.ts).
 * Runs inside the capture-processing transaction.
 */
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "#/features/ledger/orders.server";
import {
	captures,
	documents,
	orderCaptures,
	orderItems,
	orders,
} from "#/features/ledger/schema";
import { sendJobInTransaction } from "#/integrations/jobs/client.server";
import { enrichmentTasks, ingressSources } from "../schema";
import { missingParts, orderDetailUrl, shouldRequeue } from "./urls";

const EXTENSION_SOURCES = new Set([
	"amazon",
	"aliexpress",
	"alibaba",
	"ebay",
	"digikey",
	"mouser",
]);

/** Pages that already carry the full order (the extension saw the detail). */
const RICH_PAGE_TYPES = new Set(["order_detail", "invoice"]);

type EnrichmentKind = "extension_fetch" | "provider_api";

/**
 * Insert a pending task, or reopen a finished one (bounded attempts with a
 * cooldown). Returns the task id when it is newly pending.
 */
async function upsertTask(
	tx: Tx,
	input: {
		ownerId: string;
		orderId: string;
		kind: EnrichmentKind;
		source: string;
		externalOrderId: string;
		url: string | null;
	},
): Promise<string | null> {
	const [existing] = await tx
		.select({
			id: enrichmentTasks.id,
			status: enrichmentTasks.status,
			attempts: enrichmentTasks.attempts,
			finishedAt: enrichmentTasks.finishedAt,
		})
		.from(enrichmentTasks)
		.where(
			and(
				eq(enrichmentTasks.orderId, input.orderId),
				eq(enrichmentTasks.kind, input.kind),
			),
		);
	if (!existing) {
		const [row] = await tx
			.insert(enrichmentTasks)
			.values({ ...input, status: "pending" })
			.onConflictDoNothing()
			.returning({ id: enrichmentTasks.id });
		return row?.id ?? null;
	}
	if (!shouldRequeue(existing, new Date())) return null;
	await tx
		.update(enrichmentTasks)
		.set({
			status: "pending",
			url: input.url,
			externalOrderId: input.externalOrderId,
			claimedAt: null,
			finishedAt: null,
		})
		.where(eq(enrichmentTasks.id, existing.id));
	return existing.id;
}

/** Called by capture processing for every order a capture touched. */
export async function maybeQueueEnrichment(
	tx: Tx,
	input: {
		ownerId: string;
		orderId: string;
		source: string;
		captureChannel: string;
	},
): Promise<void> {
	const { ownerId, orderId, source, captureChannel } = input;
	if (!EXTENSION_SOURCES.has(source)) return;

	const [order] = await tx
		.select({
			externalOrderId: orders.externalOrderId,
			orderUrl: orders.orderUrl,
			currency: orders.currency,
			status: orders.status,
			totalMinor: orders.totalMinor,
			taxMinor: orders.taxMinor,
			paymentHint: orders.paymentHint,
			paymentMethodId: orders.paymentMethodId,
		})
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!order || order.status === "cancelled") return;

	// The capture that just arrived is the latest one linked to the order.
	if (captureChannel === "extension") {
		const [latest] = await tx
			.select({ pageType: captures.pageType, kind: captures.kind })
			.from(orderCaptures)
			.innerJoin(captures, eq(captures.id, orderCaptures.captureId))
			.where(eq(orderCaptures.orderId, orderId))
			.orderBy(desc(captures.receivedAt))
			.limit(1);
		if (!latest || RICH_PAGE_TYPES.has(latest.pageType)) return;
	}

	const [itemStats] = await tx
		.select({ total: count() })
		.from(orderItems)
		.where(eq(orderItems.orderId, orderId));
	const [unpricedRow] = await tx
		.select({ n: count() })
		.from(orderItems)
		.where(
			and(
				eq(orderItems.orderId, orderId),
				isNull(orderItems.unitPriceMinor),
				isNull(orderItems.totalMinor),
			),
		);
	const [invoice] = await tx
		.select({ id: documents.id })
		.from(documents)
		.where(
			and(
				eq(documents.orderId, orderId),
				inArray(documents.kind, ["invoice", "receipt"]),
			),
		)
		.limit(1);

	const missing = missingParts({
		itemCount: itemStats?.total ?? 0,
		itemsWithoutPrice: unpricedRow?.n ?? 0,
		totalMinor: order.totalMinor,
		taxMinor: order.taxMinor,
		hasPayment: Boolean(order.paymentHint || order.paymentMethodId),
		hasInvoice: Boolean(invoice),
	});
	if (missing.length === 0) return;

	const url = orderDetailUrl(source, order.externalOrderId, {
		orderUrl: order.orderUrl,
		currency: order.currency,
	});
	if (url)
		await upsertTask(tx, {
			ownerId,
			orderId,
			kind: "extension_fetch",
			source,
			externalOrderId: order.externalOrderId,
			url,
		});

	// The store API itself produced this capture: don't ask it again.
	if (source !== "digikey" || captureChannel === "api") return;
	const [provider] = await tx
		.select({ id: ingressSources.id })
		.from(ingressSources)
		.where(
			and(
				eq(ingressSources.ownerId, ownerId),
				eq(ingressSources.kind, "digikey_api"),
				eq(ingressSources.enabled, "on"),
			),
		)
		.limit(1);
	if (!provider) return;
	const taskId = await upsertTask(tx, {
		ownerId,
		orderId,
		kind: "provider_api",
		source,
		externalOrderId: order.externalOrderId,
		url: null,
	});
	if (taskId) await sendJobInTransaction(tx, "enrichment.provider", { taskId });
}
