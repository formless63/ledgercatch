/** Zod inputs for money server functions (client-safe). */
import { z } from "zod";
import {
	TAX_BUSINESS_TYPES,
	TAX_JURISDICTIONS,
	TAX_TREATMENTS,
} from "./constants";

const id = z.string().uuid();
const currency = z
	.string()
	.trim()
	.regex(/^[A-Za-z]{3}$/)
	.transform((v) => v.toUpperCase());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const statementFileInput = z.object({
	fileName: z.string().trim().min(1).max(250),
	/** File bytes, base64 (≤ 10 MB decoded). */
	base64: z.string().min(1).max(14_000_000),
	presetId: z.string().max(40).nullish(),
	signConvention: z.enum(["charges_positive", "charges_negative"]).nullish(),
	currency: currency.nullish(),
	dayFirst: z.boolean().optional(),
	paymentMethodId: id.nullish(),
});

export const reconcileFilterInput = z.object({
	paymentMethodId: id.nullish(),
});

export const matchIdsInput = z.object({
	matchIds: z.array(id).min(1).max(500),
});
export const confirmAboveInput = z.object({
	minScore: z.number().min(0.5).max(1),
});
export const idInput = z.object({ id });
export const ignoreInput = z.object({
	transactionIds: z.array(id).min(1).max(500),
	ignored: z.boolean(),
});
export const createOrderFromTxInput = z.object({
	transactionId: id,
	entityId: id.nullish(),
	categoryId: id.nullish(),
});
export const statementCardInput = z.object({
	importId: id,
	paymentMethodId: id.nullable(),
});

export const userCurrencyInput = z.object({ reportingCurrency: currency });
export const entitySettingsInput = z.object({
	entityId: id,
	reportingCurrency: currency.nullable(),
	taxJurisdiction: z.enum(TAX_JURISDICTIONS).nullable(),
	taxBusinessType: z.enum(TAX_BUSINESS_TYPES).nullable(),
});
export const fxRefreshInput = z.object({
	backfillDays: z.number().int().min(0).max(3650).optional(),
});

export const convertedInsightsInput = z.object({
	from: isoDate.optional(),
	to: isoDate.optional(),
	entityId: id.optional(),
	currency: currency.optional(),
});

export const acceptTaxInput = z.object({
	allocationId: id,
	treatment: z.enum(TAX_TREATMENTS),
	origin: z.enum(["suggestion", "manual"]),
	note: z.string().max(1000).nullish(),
});
export const allocationIdInput = z.object({ allocationId: id });
export const taxSummaryInput = z.object({
	year: z.number().int().min(2000).max(2100),
	entityId: id.optional(),
});
