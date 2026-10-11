import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { db } from "#/db";
import type { ParsedOrder } from "#/features/parsing/types";
import {
	appendAuditEvent,
	createAuditActor,
	createAuditSubject,
} from "#/integrations/audit-log/audit.server";
import { computeAllocations } from "./allocation";
import { buildOrderPatch, itemsSearchText, shouldReplaceItems } from "./merge";
import {
	allocations,
	claims,
	exports,
	orderCaptures,
	orderItems,
	orders,
	paymentMethods,
	shipments,
} from "./schema";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Actor =
	| { type: "user"; id: string }
	| { type: "system"; id: string };

export async function audit(
	tx: Tx,
	actor: Actor,
	action: string,
	orderId: string,
	metadata?: Record<string, unknown>,
) {
	await appendAuditEvent(tx, {
		actor: createAuditActor(actor.type, actor.id),
		action,
		subject: createAuditSubject("order", orderId),
		outcome: "success",
		metadata: metadata ?? null,
	});
}

const CARD_BRANDS = [
	"visa",
	"mastercard",
	"amex",
	"american express",
	"discover",
	"jcb",
	"unionpay",
	"paypal",
	"apple pay",
	"google pay",
];

export function brandFromHint(hint: string | undefined): string {
	const lower = (hint ?? "").toLowerCase();
	const brand = CARD_BRANDS.find((b) => lower.includes(b));
	if (!brand) return "card";
	return brand === "american express" ? "amex" : brand.replace(" ", "_");
}

const BRAND_LABELS: Record<string, string> = {
	visa: "Visa",
	mastercard: "Mastercard",
	amex: "Amex",
	discover: "Discover",
	jcb: "JCB",
	unionpay: "UnionPay",
	paypal: "PayPal",
	apple_pay: "Apple Pay",
	google_pay: "Google Pay",
};
function brandLabel(brand: string) {
	return BRAND_LABELS[brand] ?? "Card";
}

/** Find or create the payment method for a card last-4 seen on an order. */
export async function resolvePaymentMethod(
	tx: Tx,
	ownerId: string,
	last4: string,
	hint: string | undefined,
): Promise<string> {
	const brand = brandFromHint(hint);
	const existing = await tx
		.select({ id: paymentMethods.id, brand: paymentMethods.brand })
		.from(paymentMethods)
		.where(
			and(eq(paymentMethods.ownerId, ownerId), eq(paymentMethods.last4, last4)),
		);
	// Same last-4 on different brands are different cards; only merge when one
	// side is the generic "card" (brand unknown).
	const exact =
		existing.find((row) => row.brand === brand) ??
		existing.find((row) => row.brand === "card" || brand === "card");
	if (exact) return exact.id;
	const [created] = await tx
		.insert(paymentMethods)
		.values({
			ownerId,
			// The UI appends ••last4; the label is just the brand until renamed.
			label: brandLabel(brand),
			brand,
			last4,
		})
		.onConflictDoNothing()
		.returning({ id: paymentMethods.id });
	if (created) return created.id;
	const [again] = await tx
		.select({ id: paymentMethods.id })
		.from(paymentMethods)
		.where(
			and(
				eq(paymentMethods.ownerId, ownerId),
				eq(paymentMethods.brand, brand),
				eq(paymentMethods.last4, last4),
			),
		);
	if (!again) throw new Error("Payment method upsert failed");
	return again.id;
}

/** Insert or merge a parsed order. Returns the order id and whether it is new. */
export async function upsertParsedOrder(
	tx: Tx,
	ownerId: string,
	source: string,
	parsed: ParsedOrder,
	captureId: string,
): Promise<{ orderId: string; created: boolean; itemsReplaced: boolean }> {
	const [existing] = await tx
		.select({
			id: orders.id,
			status: orders.status,
			currency: orders.currency,
			paymentMethodId: orders.paymentMethodId,
		})
		.from(orders)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				eq(orders.source, source),
				eq(orders.externalOrderId, parsed.externalOrderId),
			),
		)
		.for("update");

	const patch = buildOrderPatch(existing ?? null, parsed);
	const paymentMethodId =
		parsed.paymentLast4 && !existing?.paymentMethodId
			? await resolvePaymentMethod(
					tx,
					ownerId,
					parsed.paymentLast4,
					parsed.paymentHint,
				)
			: undefined;

	let orderId: string;
	let created = false;
	if (existing) {
		orderId = existing.id;
		await tx
			.update(orders)
			.set({
				...patch,
				...(paymentMethodId ? { paymentMethodId } : {}),
				lastCapturedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(orders.id, orderId));
	} else {
		const [row] = await tx
			.insert(orders)
			.values({
				ownerId,
				source,
				externalOrderId: parsed.externalOrderId,
				...patch,
				paymentMethodId: paymentMethodId ?? null,
			})
			.returning({ id: orders.id });
		if (!row) throw new Error("Order insert failed");
		orderId = row.id;
		created = true;
	}

	const currentItems = await tx
		.select()
		.from(orderItems)
		.where(eq(orderItems.orderId, orderId))
		.orderBy(asc(orderItems.position));
	const itemsReplaced = Boolean(
		parsed.items && shouldReplaceItems(parsed, currentItems.length),
	);
	if (parsed.items && itemsReplaced) {
		const key = (item: {
			externalItemId?: string | null;
			title: string;
			sku?: string | null;
		}) => item.externalItemId || `${item.sku ?? ""}|${item.title.slice(0, 80)}`;
		const overrides = new Map(
			currentItems.map((item) => [
				key(item),
				{ entityId: item.entityId, categoryId: item.categoryId },
			]),
		);
		await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
		await tx.insert(orderItems).values(
			parsed.items.map((item, position) => ({
				orderId,
				position,
				externalItemId: item.externalItemId ?? null,
				title: item.title.slice(0, 1000),
				sku: item.sku ?? null,
				variant: item.variant ?? null,
				quantity: item.quantity > 0 ? item.quantity : 1,
				unitPriceMinor: item.unitPriceMinor ?? null,
				totalMinor:
					item.totalMinor ??
					(item.unitPriceMinor != null
						? Math.round(item.unitPriceMinor * (item.quantity || 1))
						: null),
				imageUrl: item.imageUrl ?? null,
				itemUrl: item.itemUrl ?? null,
				entityId: overrides.get(key(item))?.entityId ?? null,
				categoryId: overrides.get(key(item))?.categoryId ?? null,
			})),
		);
		await tx
			.update(orders)
			.set({ itemsText: itemsSearchText(parsed.items) })
			.where(eq(orders.id, orderId));
	}

	for (const shipment of parsed.shipments ?? []) {
		if (!shipment.trackingNumber) continue;
		await tx
			.insert(shipments)
			.values({ orderId, ...shipment })
			.onConflictDoUpdate({
				target: [shipments.orderId, shipments.trackingNumber],
				set: {
					carrier: shipment.carrier,
					status: shipment.status,
					shippedAt: shipment.shippedAt,
					deliveredAt: shipment.deliveredAt,
					etaText: shipment.etaText,
					updatedAt: new Date(),
				},
			});
	}

	await tx
		.insert(orderCaptures)
		.values({ orderId, captureId, supportedByParser: true })
		.onConflictDoUpdate({
			target: [orderCaptures.orderId, orderCaptures.captureId],
			set: { supportedByParser: true },
		});

	return { orderId, created, itemsReplaced };
}

/** Recompute derived allocations for one order (see docs/SPEC.md). */
export async function recomputeAllocations(tx: Tx, orderId: string) {
	const [order] = await tx
		.select({
			currency: orders.currency,
			entityId: orders.entityId,
			totalMinor: orders.totalMinor,
			subtotalMinor: orders.subtotalMinor,
			shippingMinor: orders.shippingMinor,
			taxMinor: orders.taxMinor,
			discountMinor: orders.discountMinor,
			categoryId: orders.categoryId,
			reimbursableOverride: orders.reimbursableOverride,
			paymentMethodId: orders.paymentMethodId,
		})
		.from(orders)
		.where(eq(orders.id, orderId));
	if (!order) return;
	const items = await tx
		.select({
			totalMinor: orderItems.totalMinor,
			entityId: orderItems.entityId,
			categoryId: orderItems.categoryId,
		})
		.from(orderItems)
		.where(eq(orderItems.orderId, orderId));
	let payingEntityId: string | null = null;
	if (order.paymentMethodId) {
		const [method] = await tx
			.select({ payingEntityId: paymentMethods.payingEntityId })
			.from(paymentMethods)
			.where(eq(paymentMethods.id, order.paymentMethodId));
		payingEntityId = method?.payingEntityId ?? null;
	}
	const existing = await tx
		.select({
			entityId: allocations.entityId,
			reimbursementStatus: allocations.reimbursementStatus,
		})
		.from(allocations)
		.where(eq(allocations.orderId, orderId));

	const computed = computeAllocations({
		order,
		items,
		payingEntityId,
		existing,
	});
	const keep = computed.map((row) => row.entityId);
	if (keep.length === 0) {
		await tx.delete(allocations).where(eq(allocations.orderId, orderId));
		return;
	}
	await tx
		.delete(allocations)
		.where(
			and(
				eq(allocations.orderId, orderId),
				notInArray(allocations.entityId, keep),
			),
		);
	const previousAmounts = new Map(
		(
			await tx
				.select({
					id: allocations.id,
					entityId: allocations.entityId,
					amountMinor: allocations.amountMinor,
					claimId: allocations.claimId,
				})
				.from(allocations)
				.where(eq(allocations.orderId, orderId))
		).map((row) => [row.entityId, row]),
	);
	for (const row of computed) {
		const previous = previousAmounts.get(row.entityId);
		if (previous && previous.amountMinor !== row.amountMinor) {
			// Downstream snapshots no longer match: flag them instead of silently drifting.
			await tx
				.update(exports)
				.set({ status: "stale", error: "Order amount changed after export" })
				.where(
					and(
						eq(exports.allocationId, previous.id),
						eq(exports.status, "sent"),
					),
				);
			if (previous.claimId) {
				await tx
					.update(claims)
					.set({
						amountChangedAt: new Date(),
						totalMinor: sql`${claims.totalMinor} + ${row.amountMinor - previous.amountMinor}`,
					})
					.where(eq(claims.id, previous.claimId));
			}
		}
		await tx
			.insert(allocations)
			.values({ orderId, ...row })
			.onConflictDoUpdate({
				target: [allocations.orderId, allocations.entityId],
				set: {
					categoryId: row.categoryId,
					amountMinor: row.amountMinor,
					currency: row.currency,
					reimbursable: row.reimbursable,
					reimbursementStatus: row.reimbursementStatus,
					updatedAt: new Date(),
				},
			});
	}
}
