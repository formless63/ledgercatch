/** Client-safe input schemas and constants for automation server functions. */
import { z } from "zod";

export const WEBHOOK_EVENT_TYPES = [
	"order.created",
	"order.filed",
	"order.assigned",
	"claim.created",
	"claim.paid",
	"export.sent",
	"export.failed",
	"capture.failed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const BUDGET_PERIOD_OPTIONS = ["month", "quarter", "year"] as const;

export const budgetInput = z.object({
	id: z.string().uuid().optional(),
	entityId: z.string().uuid(),
	categoryId: z.string().uuid().nullable().optional(),
	period: z.enum(BUDGET_PERIOD_OPTIONS),
	amountMinor: z.number().int().positive().max(1e13),
	currency: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{3}$/),
	thresholdPct: z.number().int().min(1).max(100).default(80),
	enabled: z.boolean().default(true),
});

export const endpointInput = z.object({
	id: z.string().uuid().optional(),
	name: z.string().trim().min(1).max(120),
	url: z.string().trim().url().max(2048),
	events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(20),
	enabled: z.boolean().default(true),
	/** Generate a new signing secret (always true on create). */
	rotateSecret: z.boolean().optional(),
});

export const claimSettingsInput = z.object({
	connectionId: z.string().uuid(),
	autoDraft: z.boolean(),
	policy: z
		.object({
			currencyId: z.string().trim().min(1).max(32),
			currency: z
				.string()
				.trim()
				.toUpperCase()
				.regex(/^[A-Z]{3}$/),
			configurationIdentity: z.string().trim().min(1).max(128),
			/** Operator attests the policy checklist in docs/AUTOMATION.md. */
			verified: z.literal(true),
		})
		.nullable(),
});

export const clientMappingInput = z.object({
	connectionId: z.string().uuid(),
	entityId: z.string().uuid(),
	/** Invoice Ninja client hashed id; null removes the mapping. */
	remoteClientId: z.string().trim().min(1).max(128).nullable(),
});
