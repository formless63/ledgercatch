/**
 * Analytics data layers in inline scripts: GA4 `purchase` events
 * (`transaction_id`, `value`, `items[]`) and Universal Analytics
 * `ecommerce.purchase.actionField`. Used on thank-you pages by most
 * platforms' tracking plugins.
 */
import type { Doc } from "../html";
import {
	isRecord,
	type JsonRecord,
	num,
	objectsAroundKey,
	records,
	str,
} from "../json";
import { normalizeCurrencyCode, toMinor } from "../money";
import type { ParsedItem, ParsedOrder } from "../types";

export function ecommerceOrder(
	obj: JsonRecord,
	base: string,
): ParsedOrder | undefined {
	// GA4: { transaction_id, value, tax, shipping, currency, items[] }
	const id =
		str(obj.transaction_id) ?? str(obj.transactionId) ?? str(obj.order_number);
	if (id) {
		const currency = normalizeCurrencyCode(
			str(obj.currency) ?? str(obj.currencyCode),
		);
		const m = (v: unknown) =>
			num(v) === undefined ? undefined : toMinor(num(v) as number, currency);
		const items: ParsedItem[] = records(obj.items ?? obj.products ?? []).map(
			(it) => {
				const quantity = num(it.quantity) ?? 1;
				const unit = m(it.price);
				return {
					title: str(it.item_name) ?? str(it.name) ?? "",
					sku: str(it.item_id) ?? str(it.sku) ?? str(it.id),
					variant: str(it.item_variant) ?? str(it.variant),
					quantity,
					unitPriceMinor: unit,
					totalMinor: unit === undefined ? undefined : unit * quantity,
				};
			},
		);
		return {
			externalOrderId: id,
			currency,
			totalMinor: m(obj.value ?? obj.revenue ?? obj.transactionTotal),
			taxMinor: m(obj.tax ?? obj.transactionTax),
			shippingMinor: m(obj.shipping ?? obj.transactionShipping),
			merchantName: str(obj.affiliation),
			items: items.filter((i) => i.title).length ? items : undefined,
		};
	}
	// Universal Analytics: { purchase: { actionField: { id, revenue, ... }, products[] } }
	const purchase = isRecord(obj.purchase) ? obj.purchase : obj;
	if (isRecord(purchase.actionField)) {
		const af = purchase.actionField;
		const order = ecommerceOrder(
			{
				transaction_id: af.id,
				value: af.revenue,
				tax: af.tax,
				shipping: af.shipping,
				affiliation: af.affiliation,
				currency: obj.currencyCode,
				items: purchase.products,
			},
			base,
		);
		return order;
	}
	return undefined;
}

export function dataLayerOrders($: Doc, base: string): ParsedOrder[] {
	const out: ParsedOrder[] = [];
	$("script:not([src])").each((_, el) => {
		const code = $(el).text();
		if (code.length > 500_000) return;
		if (!/transaction_?id|actionField/i.test(code)) return;
		for (const obj of objectsAroundKey(
			code,
			/["']?(?:transaction_id|transactionId|actionField)["']?\s*:/,
		)) {
			const order = ecommerceOrder(obj, base);
			if (order) out.push(order);
		}
	});
	return out;
}
