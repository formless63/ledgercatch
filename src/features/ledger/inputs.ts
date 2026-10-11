/** Zod input schemas for ledger server functions (shared by client and server). */
import { z } from "zod";
import { STORE_IDS } from "#/shared/capture";

const id = z.string().uuid();
const nullableId = id.nullable();

export const ORDER_VIEWS = ["inbox", "all", "filed", "ignored"] as const;
export const REIMBURSEMENT_FILTERS = [
	"pending",
	"submitted",
	"reimbursed",
	"reimbursable",
] as const;

export const orderListInput = z.object({
	view: z.enum(ORDER_VIEWS).default("all"),
	entityId: id.or(z.literal("unassigned")).optional(),
	source: z.enum(STORE_IDS).optional(),
	status: z.string().max(20).optional(),
	reimbursement: z.enum(REIMBURSEMENT_FILTERS).optional(),
	missingInvoice: z.boolean().optional(),
	from: z.string().date().optional(),
	to: z.string().date().optional(),
	q: z.string().trim().max(200).optional(),
	sort: z
		.enum(["date_desc", "date_asc", "total_desc", "captured_desc"])
		.default("date_desc"),
	limit: z.number().int().min(1).max(500).default(100),
	offset: z.number().int().min(0).max(100_000).default(0),
});
export type OrderListInput = z.input<typeof orderListInput>;

export const idInput = z.object({ id });

export const orderUpdateInput = z.object({
	id,
	entityId: nullableId.optional(),
	categoryId: nullableId.optional(),
	paymentMethodId: nullableId.optional(),
	reimbursableOverride: z.boolean().nullable().optional(),
	reviewState: z.enum(["inbox", "filed", "ignored"]).optional(),
	notes: z.string().max(5000).nullable().optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	merchantName: z.string().trim().max(200).nullable().optional(),
});
export type OrderUpdateInput = z.infer<typeof orderUpdateInput>;

export const bulkOrderUpdateInput = z.object({
	ids: z.array(id).min(1).max(500),
	entityId: nullableId.optional(),
	categoryId: nullableId.optional(),
	reimbursableOverride: z.boolean().nullable().optional(),
	reviewState: z.enum(["inbox", "filed", "ignored"]).optional(),
});

export const orderItemUpdateInput = z.object({
	itemId: id,
	entityId: nullableId.optional(),
	categoryId: nullableId.optional(),
});

const decimal = z
	.string()
	.trim()
	.regex(/^-?\d+(\.\d{1,2})?$/, "Use a decimal amount like 12.34");

export const manualOrderInput = z.object({
	merchantName: z.string().trim().min(1).max(200),
	externalOrderId: z.string().trim().max(120).optional(),
	orderDate: z.string().date(),
	currency: z.string().trim().length(3).toUpperCase(),
	total: decimal,
	tax: decimal.optional(),
	shipping: decimal.optional(),
	entityId: nullableId.optional(),
	categoryId: nullableId.optional(),
	paymentMethodId: nullableId.optional(),
	notes: z.string().max(5000).optional(),
	items: z
		.array(
			z.object({
				title: z.string().trim().min(1).max(500),
				quantity: z.number().positive().default(1),
				total: decimal.optional(),
			}),
		)
		.max(100)
		.default([]),
});

export const reimbursementStatusInput = z.object({
	allocationIds: z.array(id).min(1).max(500),
	status: z.enum(["none", "pending", "submitted", "reimbursed", "rejected"]),
});

export const createClaimInput = z.object({
	allocationIds: z.array(id).min(1).max(500),
	reference: z.string().trim().max(120).optional(),
	notes: z.string().max(2000).optional(),
});

export const claimStatusInput = z.object({
	id,
	status: z.enum(["draft", "submitted", "paid", "void"]),
	reference: z.string().trim().max(120).optional(),
});

export const ENTITY_COLOR_OPTIONS = [
	"indigo",
	"emerald",
	"sky",
	"purple",
	"amber",
	"pink",
	"teal",
] as const;

export const entityInput = z.object({
	id: id.optional(),
	name: z.string().trim().min(1).max(120),
	shortName: z.string().trim().max(24).nullable().optional(),
	kind: z.enum(["personal", "business"]),
	color: z.enum(ENTITY_COLOR_OPTIONS),
	isDefault: z.boolean().optional(),
	sort: z.number().int().min(0).max(10_000).optional(),
	archived: z.boolean().optional(),
});

export const categoryInput = z.object({
	id: id.optional(),
	name: z.string().trim().min(1).max(120),
	code: z.string().trim().max(40).nullable().optional(),
	entityId: nullableId.optional(),
	archived: z.boolean().optional(),
});

export const paymentMethodInput = z.object({
	id: id.optional(),
	label: z.string().trim().min(1).max(120),
	brand: z.string().trim().max(30).optional(),
	last4: z
		.string()
		.trim()
		.regex(/^\d{0,4}$/)
		.optional(),
	payingEntityId: nullableId.optional(),
	archived: z.boolean().optional(),
});

export const ruleConditionInput = z.object({
	field: z.enum([
		"source",
		"merchant",
		"item_title",
		"sku",
		"payment_last4",
		"placed_by_group",
		"ship_to_address",
		"checkout_email_domain",
		"total",
		"currency",
	]),
	op: z.enum(["equals", "contains", "matches", "gt", "lt"]),
	value: z.string().trim().min(1).max(500),
});

export const ruleActionsInput = z.object({
	entityId: id.optional(),
	categoryId: id.optional(),
	reimbursable: z.enum(["auto", "yes", "no"]).optional(),
	file: z.boolean().optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

export const ruleInput = z.object({
	id: id.optional(),
	name: z.string().trim().min(1).max(120),
	enabled: z.boolean().default(true),
	priority: z.number().int().min(0).max(100_000).default(100),
	match: z.enum(["all", "any"]).default("all"),
	conditions: z.array(ruleConditionInput).min(1).max(20),
	actions: ruleActionsInput,
});
export type RuleInput = z.input<typeof ruleInput>;

export const captureListInput = z.object({
	status: z
		.enum([
			"pending",
			"parsed",
			"no_orders",
			"needs_review",
			"failed",
			"ignored",
		])
		.optional(),
	source: z.enum(STORE_IDS).optional(),
	limit: z.number().int().min(1).max(200).default(100),
	offset: z.number().int().min(0).default(0),
});

export const insightsInput = z.object({
	from: z.string().date().optional(),
	to: z.string().date().optional(),
	entityId: id.optional(),
});
