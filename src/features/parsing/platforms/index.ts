/**
 * Storefront-platform parsers chained by the generic parser before
 * schema.org / data-layer extraction and text heuristics.
 *
 * Supported (documented, theme-stable markup): Shopify (classic account
 * order page, legacy checkout.liquid thank-you), WooCommerce (classic +
 * block order confirmation, My Account view-order), PrestaShop 1.7/8
 * classic theme, Magento 2 / Adobe Commerce Luma, BigCommerce (checkout-js
 * confirmation, Stencil account order), Medusa v2 Next.js starter.
 */
import type { ParsedOrder } from "../types";
import { bigcommerce } from "./bigcommerce";
import { magento } from "./magento";
import { medusa } from "./medusa";
import { prestashop } from "./prestashop";
import { shopify } from "./shopify";
import type { Platform, PlatformContext } from "./types";
import { woocommerce } from "./woocommerce";

export type { Platform, PlatformContext } from "./types";

export const PLATFORMS: readonly Platform[] = [
	shopify,
	woocommerce,
	prestashop,
	magento,
	bigcommerce,
	medusa,
];

/** Platforms whose `detect` accepts this page (cheap; no DOM work). */
export function detectPlatforms(html: string, url: string): Platform[] {
	return PLATFORMS.filter((p) => {
		try {
			return p.detect(html, url);
		} catch {
			return false;
		}
	});
}

/**
 * Runs the first detected platform parser that yields orders. Returns the
 * platform id with its orders, or undefined when none matched.
 */
export function platformOrders(
	ctx: PlatformContext,
): { platform: string; orders: ParsedOrder[] } | undefined {
	for (const platform of detectPlatforms(ctx.html, ctx.url)) {
		const orders = platform.parse(ctx);
		if (orders.length > 0) return { platform: platform.id, orders };
	}
	return undefined;
}
