/**
 * Order-page detection for storefront platforms on arbitrary sites (the
 * opt-in "Auto-detect order confirmations on other sites" feature).
 *
 * Pure: URL regexes + `querySelector` probes against platform-specific
 * markup taken from each platform's own templates (Shopify Dawn / checkout,
 * WooCommerce templates + order-confirmation blocks, PrestaShop classic
 * theme, Magento Luma, BigCommerce checkout-js / Cornerstone, Medusa
 * Next.js starter). Only thank-you / order-confirmation / order-detail pages
 * match; cart, checkout-in-progress and product pages never do.
 *
 * Mirrors the server's `src/features/parsing/platforms/*` detectors.
 */
import { STORE_MATCHES, storeForUrl } from "./stores";

export type DetectedPlatform = "shopify" | "woocommerce" | "prestashop" | "magento" | "bigcommerce" | "medusa";
export type DetectedPageType = "order_confirmation" | "order_detail";

export interface DetectedOrderPage {
	platform: DetectedPlatform;
	pageType: DetectedPageType;
}

/** The subset of `Document` the detector needs (easy to fake in tests). */
export interface QueryRoot {
	querySelector(selector: string): Element | null;
}

/** Match patterns for `scripting.registerContentScripts` (all sites). */
export const ALL_SITES_PATTERNS = ["https://*/*", "http://*/*"];

/** Never an order page: carts, product pages, in-progress checkout steps. */
const NOT_ORDER_PATH_RE =
	/\/(?:cart|basket|warenkorb|panier|carrito|carrello)(?:[/?#]|$)|\/checkout\/cart\b|\/products?\/|\/product-category\//i;

const SHOPIFY_MARKERS = [
	'meta[name="shopify-checkout-api-token"]',
	'meta[name="shopify-digital-wallet"]',
	'link[href*="cdn.shopify.com"]',
	'script[src*="cdn.shopify.com"]',
	'link[href*="/cdn/shop/"]',
	".shopify-section",
].join(", ");

function has(root: QueryRoot, selector: string): boolean {
	try {
		return root.querySelector(selector) !== null;
	} catch {
		return false;
	}
}

function parseUrl(url: string): URL | null {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) ? u : null;
	} catch {
		return null;
	}
}

type Rule = { platform: DetectedPlatform; pageType: DetectedPageType; test: (u: URL, root: QueryRoot) => boolean };

const RULES: Rule[] = [
	// --- WooCommerce (templates/checkout/thankyou.php, OrderConfirmation blocks, myaccount/view-order.php)
	{
		platform: "woocommerce",
		pageType: "order_confirmation",
		test: (_u, r) =>
			has(r, ".woocommerce-order-overview .woocommerce-order-overview__order") ||
			has(r, ".wc-block-order-confirmation-summary-list"),
	},
	{
		platform: "woocommerce",
		pageType: "order_detail",
		test: (_u, r) => has(r, "mark.order-number") && has(r, ".woocommerce-table--order-details"),
	},
	// --- PrestaShop 1.7/8 classic theme
	{
		platform: "prestashop",
		pageType: "order_confirmation",
		test: (_u, r) => has(r, "body#order-confirmation #order-reference-value"),
	},
	{
		platform: "prestashop",
		pageType: "order_detail",
		test: (_u, r) => has(r, "body#order-detail #order-infos"),
	},
	// --- Magento 2 / Adobe Commerce (Luma)
	{
		platform: "magento",
		pageType: "order_confirmation",
		test: (_u, r) => has(r, "body.checkout-onepage-success .checkout-success"),
	},
	{
		platform: "magento",
		pageType: "order_detail",
		test: (_u, r) =>
			has(r, "body.sales-order-view #my-orders-table") ||
			has(r, "body.sales-guest-view #my-orders-table") ||
			has(r, "body.sales-order-view .order-details-items"),
	},
	// --- BigCommerce (checkout-js confirmation, Stencil account order)
	{
		platform: "bigcommerce",
		pageType: "order_confirmation",
		test: (_u, r) => has(r, '[data-test="order-confirmation-order-number-text"]'),
	},
	{
		platform: "bigcommerce",
		pageType: "order_detail",
		test: (u, r) =>
			/\/account\.php$/i.test(u.pathname) &&
			u.searchParams.get("action") === "view_order" &&
			has(r, ".account-orderTotal"),
	},
	// --- Medusa v2 Next.js starter
	{
		platform: "medusa",
		pageType: "order_confirmation",
		test: (_u, r) => has(r, '[data-testid="order-complete-container"] [data-testid="order-id"]'),
	},
	{
		platform: "medusa",
		pageType: "order_detail",
		test: (_u, r) => has(r, '[data-testid="order-details-container"] [data-testid="order-id"]'),
	},
	// --- Shopify
	{
		platform: "shopify",
		pageType: "order_confirmation",
		test: (u, r) =>
			(has(r, ".os-order-number") ||
				/\/checkouts\/(?:(?:c|cn)\/)?[\w-]+\/thank[-_]?you\/?$/i.test(u.pathname)) &&
			has(r, SHOPIFY_MARKERS),
	},
	{
		platform: "shopify",
		pageType: "order_detail",
		test: (u, r) =>
			// New customer accounts live on Shopify's own host.
			(/^(?:www\.)?shopify\.com$/i.test(u.hostname) && /^\/\d+\/account\/orders\/\d+\/?$/.test(u.pathname)) ||
			(has(r, "table.order-details #ColumnProduct") && has(r, SHOPIFY_MARKERS)) ||
			(/^\/\d+\/orders\/[0-9a-f]{16,}\/?$/i.test(u.pathname) && has(r, SHOPIFY_MARKERS)),
	},
];

/** Which platform order page this is, or null (never for carts / products). */
export function detectOrderPage(url: string, root: QueryRoot): DetectedOrderPage | null {
	const u = parseUrl(url);
	if (!u) return null;
	if (NOT_ORDER_PATH_RE.test(u.pathname)) return null;
	for (const rule of RULES) {
		if (rule.test(u, root)) return { platform: rule.platform, pageType: rule.pageType };
	}
	return null;
}

/**
 * Pages that are only worth watching for late-rendered order markup (SPAs
 * such as BigCommerce's checkout or Medusa / Shopify client navigations).
 * Elsewhere the detector checks once and stops.
 */
export function mayBecomeOrderPage(url: string): boolean {
	const u = parseUrl(url);
	if (!u || NOT_ORDER_PATH_RE.test(u.pathname)) return false;
	return /checkout|order|thank|confirm|success|account|commande|bestell|pedido/i.test(`${u.pathname}${u.search}`);
}

function hostOf(url: string): string | null {
	return parseUrl(url)?.hostname.toLowerCase() ?? null;
}

/**
 * The detector never runs on the user's own server or on dedicated store
 * domains (those have their own capture logic).
 */
export function isExcludedUrl(url: string, serverUrl: string): boolean {
	const host = hostOf(url);
	if (!host) return true;
	if (storeForUrl(url)) return true;
	const serverHost = serverUrl ? hostOf(serverUrl) : null;
	return serverHost !== null && serverHost === host;
}

/** `excludeMatches` for the registered detector script. */
export function detectorExcludeMatches(serverUrl: string): string[] {
	const out = [...STORE_MATCHES];
	const serverHost = serverUrl ? hostOf(serverUrl) : null;
	// Match patterns cannot carry a port; excluding the host covers every port.
	if (serverHost) out.push(`*://${serverHost}/*`);
	return out;
}

/** The URL identity used for "once per URL" (no fragment). */
export function detectorUrlKey(url: string): string {
	const u = parseUrl(url);
	if (!u) return url;
	u.hash = "";
	u.username = "";
	u.password = "";
	return u.toString();
}
