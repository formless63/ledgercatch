/**
 * Deterministic email → orders chain (no AI, no I/O):
 *
 *   (a) schema.org Order / ParcelDelivery markup (Gmail email markup)
 *   (b) store-specific confirmation / shipping parsers (stores.ts)
 *   (c) storefront platforms + text heuristics for unknown shops (generic.ts)
 *
 * Callers fall back to AI extraction when this returns no orders.
 */
import { buildResult, safeParse } from "../result";
import type { ParsedOrder } from "../types";
import { buildEmailContext, statusForKind } from "./common";
import {
	genericEmailOrders,
	shopIdentity,
	structuredEmailOrders,
} from "./generic";
import { EMAIL_STORE_PARSERS } from "./stores";
import type { EmailMessage, EmailParseOutcome } from "./types";

export { detectStoreFromSender } from "./detect";
export type { EmailMessage, EmailParseOutcome } from "./types";

export const EMAIL_PARSER_VERSION = 1;

export function parseEmailMessage(email: EmailMessage): EmailParseOutcome {
	let parserId = "email";
	const result = safeParse("email", () => {
		const ctx = buildEmailContext(email);
		if (ctx.lines.length === 0 && !ctx.subject)
			return { outcome: "no_orders", reason: "empty email" };
		const store = EMAIL_STORE_PARSERS[email.source];
		const base = store
			? `https://www.${email.source}.com/`
			: `https://${ctx.senderDomain || "unknown-shop.invalid"}/`;
		const structured = structuredEmailOrders(ctx, base).map(
			(o): ParsedOrder => ({
				...o,
				status: o.status ?? statusForKind(ctx.kind),
			}),
		);
		const warnings: string[] = [];
		const orders: ParsedOrder[] = [];
		if (structured.length) {
			parserId = "email-schema";
			warnings.push("email: schema.org markup");
		}
		if (store) {
			const found = store.parse(ctx);
			if (found.orders.length)
				parserId = structured.length ? `${store.id}+schema` : store.id;
			// Structured markup wins per field; the store parser fills gaps.
			orders.push(...structured, ...found.orders);
			warnings.push(...found.warnings);
			return buildResult(
				orders,
				warnings,
				found.reason ?? `no ${email.source} order in email`,
			);
		}
		if (structured.length) {
			// Unknown shop with markup: attach the shop host / order link so the
			// order id is namespaced like page captures of the same shop.
			const shop = shopIdentity(ctx);
			return buildResult(
				structured.map((o) => ({
					...o,
					merchantName: o.merchantName ?? email.from?.name ?? shop.host,
					orderUrl: o.orderUrl ?? shop.orderUrl ?? `https://${shop.host}/`,
					orderDate:
						o.orderDate ??
						(ctx.kind === "confirmation" ? ctx.emailDate : undefined),
				})),
				warnings,
				"no orders",
			);
		}
		const generic = genericEmailOrders(ctx);
		if (generic.orders.length) parserId = "generic-email";
		return buildResult(
			generic.orders,
			generic.warnings,
			generic.reason ?? "no order data in email",
		);
	});
	return { result, parserId, version: EMAIL_PARSER_VERSION };
}
