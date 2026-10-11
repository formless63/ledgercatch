/** Validated inputs for lifecycle server functions. */
import { z } from "zod";
import { ASSET_STATUSES, REFUND_STATUSES } from "./schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
const optionalText = (max: number) =>
	z.string().trim().max(max).nullable().optional();

export const orderIdInput = z.object({ orderId: uuid });
export const idOnlyInput = z.object({ id: uuid });

export const refundCreateInput = z.object({
	orderId: uuid,
	orderItemId: uuid.nullable().optional(),
	amountMinor: z.number().int().positive().max(1e13),
	currency: z
		.string()
		.trim()
		.length(3)
		.transform((s) => s.toUpperCase()),
	reason: optionalText(500),
	status: z.enum(REFUND_STATUSES).default("requested"),
	refundedAt: isoDate.nullable().optional(),
	documentId: uuid.nullable().optional(),
});

export const refundUpdateInput = z.object({
	id: uuid,
	status: z.enum(REFUND_STATUSES).optional(),
	amountMinor: z.number().int().positive().max(1e13).optional(),
	reason: optionalText(500),
	refundedAt: isoDate.nullable().optional(),
});

export const netSpendInput = z.object({
	from: isoDate.optional(),
	to: isoDate.optional(),
	entityId: uuid.optional(),
});

export const assetSaveInput = z.object({
	id: uuid.optional(),
	orderItemId: uuid.nullable().optional(),
	orderId: uuid.nullable().optional(),
	entityId: uuid.nullable().optional(),
	name: z.string().trim().min(1).max(300),
	serial: optionalText(200),
	purchaseDate: isoDate.nullable().optional(),
	warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
	warrantyExpiresAt: isoDate.nullable().optional(),
	location: optionalText(200),
	notes: optionalText(4000),
	status: z.enum(ASSET_STATUSES).default("in_service"),
	documentIds: z.array(uuid).max(50).optional(),
});

export const assetListInput = z.object({
	status: z.enum(ASSET_STATUSES).optional(),
	entityId: uuid.optional(),
	/** Warranty ends within N days (and not yet expired). */
	expiringWithinDays: z.number().int().min(1).max(3650).optional(),
	q: z.string().trim().max(200).optional(),
});

export const itemSearchInput = z.object({
	q: z.string().trim().max(200).default(""),
	limit: z.number().int().min(1).max(1000).default(400),
});

export const itemHistoryInput = z.object({
	title: z.string().trim().min(1).max(1000),
	sku: z.string().trim().max(200).nullable().optional(),
});

export const mergeOrdersInput = z
	.object({ keepId: uuid, dropId: uuid })
	.refine((v) => v.keepId !== v.dropId, "Cannot merge an order into itself");

export const dismissDuplicateInput = z.object({
	orderId: uuid,
	otherId: uuid,
});

export const duplicateFlagsInput = z.object({
	orderIds: z.array(uuid).max(500),
});

export const documentLinkInput = z.object({
	documentId: uuid,
	orderId: uuid,
});
