/** Which store sent an email: sender domain first, then subject/body hints. */
import type { StoreId } from "#/shared/capture";

const DOMAIN_STORES: Array<[RegExp, StoreId]> = [
	// AliExpress before Alibaba: both are Alibaba Group, different stores.
	[/(^|\.)aliexpress\.[a-z.]+$|(^|\.)aliexpress-media\.com$/, "aliexpress"],
	[/(^|\.)alibaba\.com$|(^|\.)alibaba-inc\.com$/, "alibaba"],
	// amazonses.com (the ESP) deliberately does not match.
	[/(^|\.)amazon\.[a-z.]+$/, "amazon"],
	[/(^|\.)ebay\.[a-z.]+$/, "ebay"],
	[/(^|\.)digikey\.[a-z.]+$|(^|\.)digi-key\.com$/, "digikey"],
	[/(^|\.)mouser\.[a-z.]+$/, "mouser"],
];

const SUBJECT_STORES: Array<[RegExp, StoreId]> = [
	[/\bamazon\.[a-z.]{2,6}\b.*\border\b|\bamazon order\b/i, "amazon"],
	[/\baliexpress\b/i, "aliexpress"],
	[/\balibaba(\.com)?\b|trade assurance/i, "alibaba"],
	[/\bebay\b/i, "ebay"],
	[/\bdigi-?key\b/i, "digikey"],
	[/\bmouser\b/i, "mouser"],
];

const BODY_STORES: Array<[RegExp, StoreId]> = [
	[
		/amazon\.[a-z.]{2,6}\/(?:gp\/(?:your-account|css|aw\/od)|your-orders|progress-tracker)/i,
		"amazon",
	],
	[/aliexpress\.[a-z]{2,3}\/p\/order\//i, "aliexpress"],
	[/(?:biz|trade|message)\.alibaba\.com\//i, "alibaba"],
	[/ebay\.[a-z.]{2,6}\/(?:vod|mye|ord|ulk\/vod)/i, "ebay"],
	[/digikey\.[a-z.]{2,6}\/(?:OrderHistory|en\/orders|ordering)/i, "digikey"],
	[/mouser\.[a-z.]{2,6}\/(?:OrderHistory|orderhistory|Cart)/i, "mouser"],
];

export function emailDomain(address: string | undefined | null): string {
	const at = address?.lastIndexOf("@") ?? -1;
	return at >= 0 && address
		? address
				.slice(at + 1)
				.toLowerCase()
				.trim()
		: "";
}

export function storeFromDomain(domain: string): StoreId | undefined {
	for (const [re, store] of DOMAIN_STORES) if (re.test(domain)) return store;
	return undefined;
}

/**
 * Store id for an email: amazon / aliexpress / ebay / digikey / mouser /
 * alibaba, or "generic" (Shopify, WooCommerce and everything else).
 */
export function detectStoreFromSender(
	from: string | null | undefined,
	subject: string | null | undefined,
	html: string | null | undefined,
): StoreId {
	const byDomain = storeFromDomain(emailDomain(from));
	if (byDomain) return byDomain;
	const subj = subject ?? "";
	for (const [re, store] of SUBJECT_STORES) if (re.test(subj)) return store;
	const body = (html ?? "").slice(0, 400_000);
	for (const [re, store] of BODY_STORES) if (re.test(body)) return store;
	return "generic";
}
