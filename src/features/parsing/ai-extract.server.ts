import { z } from "zod";
import { generateStructured } from "#/integrations/ai/ai.server";
import { minorDigits } from "./money";
import type { ParsedOrder, ParseResult, ParserInput } from "./types";

/**
 * Strip obvious personal data before text leaves the box: email addresses,
 * phone numbers and space/dash-grouped card numbers (last 4 kept so card
 * matching still works). Contiguous digit runs are kept: they are usually
 * order numbers (AliExpress uses 16 digits).
 */
export function redactForAi(text: string): string {
	return text
		.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
		.replace(
			/\b(?:\d{4}[ -]){3}\d{1,7}\b/g,
			(match) => `[number •••${match.replace(/\D/g, "").slice(-4)}]`,
		)
		.replace(
			/(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
			"[phone]",
		);
}

export function aiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.AI_MODEL?.trim());
}

const money = z.number().nonnegative().nullable();
const extractionSchema = z.object({
	isOrder: z.boolean(),
	reason: z.string().max(500).nullable().optional(),
	orders: z
		.array(
			z.object({
				orderNumber: z.string().min(1).max(120),
				merchantName: z.string().max(200).nullable(),
				orderDate: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.nullable(),
				currency: z
					.string()
					.regex(/^[A-Za-z]{3}$/)
					.nullable(),
				subtotal: money,
				shipping: money,
				tax: money,
				discount: money,
				total: money,
				paymentDescription: z.string().max(120).nullable(),
				cardLast4: z
					.string()
					.regex(/^\d{4}$/)
					.nullable(),
				status: z
					.enum([
						"placed",
						"processing",
						"shipped",
						"delivered",
						"cancelled",
						"returned",
						"unknown",
					])
					.nullable(),
				items: z
					.array(
						z.object({
							title: z.string().min(1).max(500),
							sku: z.string().max(120).nullable(),
							quantity: z.number().positive().nullable(),
							unitPrice: money,
							lineTotal: money,
						}),
					)
					.max(100),
				trackingNumbers: z.array(z.string().max(80)).max(10).nullable(),
			}),
		)
		.max(20)
		.default([]),
});

const SYSTEM_PROMPT = `You extract purchase-order data from the visible text of a web page or e-commerce email.
Return ONLY a JSON object with this shape:
{"isOrder": boolean, "reason": string|null, "orders": [{"orderNumber": string, "merchantName": string|null, "orderDate": "YYYY-MM-DD"|null, "currency": "ISO-4217"|null, "subtotal": number|null, "shipping": number|null, "tax": number|null, "discount": number|null, "total": number|null, "paymentDescription": string|null, "cardLast4": "1234"|null, "status": "placed"|"processing"|"shipped"|"delivered"|"cancelled"|"returned"|"unknown"|null, "items": [{"title": string, "sku": string|null, "quantity": number|null, "unitPrice": number|null, "lineTotal": number|null}], "trackingNumbers": string[]|null}]}
Rules: amounts are decimal numbers in the order currency (not cents). Only include orders actually shown (an order confirmation, receipt, invoice, or order detail). Do not invent values; use null when absent. If the page is not an order, return {"isOrder": false, "reason": "...", "orders": []}.`;

const toMinorIn =
	(currency: string | null | undefined) => (value: number | null | undefined) =>
		value == null
			? undefined
			: Math.round(
					value * 10 ** minorDigits(currency?.toUpperCase() ?? undefined),
				);

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return undefined;
	}
}

export async function extractWithAi(input: ParserInput): Promise<ParseResult> {
	if (!aiConfigured())
		return {
			outcome: "unsupported",
			reason:
				"AI extraction is not configured (set AI_MODEL and provider settings). Review this capture manually.",
		};
	const text =
		input.payload.type === "text"
			? input.payload.text
			: input.payload.type === "html"
				? input.payload.html
						.replace(/<script[\s\S]*?<\/script>/gi, " ")
						.replace(/<style[\s\S]*?<\/style>/gi, " ")
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
				: JSON.stringify(input.payload.body);
	const note = input.payload.type === "text" ? input.payload.note : undefined;
	const { object } = await generateStructured(
		{
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{
					role: "user",
					content: `URL: ${input.pageUrl}\nTitle: ${input.pageTitle}\n${note ? `User note: ${note}\n` : ""}Captured: ${input.capturedAt}\n---\n${redactForAi(text).slice(0, 60_000)}`,
				},
			],
			temperature: 0,
			maxOutputTokens: 4000,
		},
		extractionSchema,
	);
	if (!object.isOrder || object.orders.length === 0)
		return {
			outcome: "no_orders",
			reason: object.reason ?? "No order found on page",
		};
	const merchantFallback = hostOf(input.pageUrl);
	const orders: ParsedOrder[] = object.orders.map((order) => {
		const toMinor = toMinorIn(order.currency);
		return {
			externalOrderId: order.orderNumber.trim(),
			merchantName: order.merchantName ?? merchantFallback,
			orderUrl: input.pageUrl,
			orderDate: order.orderDate ?? input.capturedAt.slice(0, 10),
			status: order.status ?? "unknown",
			currency: order.currency?.toUpperCase(),
			subtotalMinor: toMinor(order.subtotal),
			shippingMinor: toMinor(order.shipping),
			taxMinor: toMinor(order.tax),
			discountMinor: toMinor(order.discount),
			totalMinor: toMinor(order.total),
			paymentHint: order.paymentDescription ?? undefined,
			paymentLast4: order.cardLast4 ?? undefined,
			items: order.items.map((item) => ({
				title: item.title,
				sku: item.sku ?? undefined,
				quantity: item.quantity ?? 1,
				unitPriceMinor: toMinor(item.unitPrice),
				totalMinor: toMinor(item.lineTotal),
			})),
			shipments: (order.trackingNumbers ?? []).map((trackingNumber) => ({
				trackingNumber,
			})),
		};
	});
	return {
		outcome: "orders",
		orders,
		warnings: ["Extracted by AI — verify amounts"],
	};
}
