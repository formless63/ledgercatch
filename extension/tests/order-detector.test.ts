import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { captureHtml, stripForCapture } from "@/lib/html";
import {
	type QueryRoot,
	detectOrderPage,
	detectorExcludeMatches,
	detectorUrlKey,
	isExcludedUrl,
	mayBecomeOrderPage,
} from "@/lib/order-detector";

/** Server parser fixtures (markup mirrored from each platform's templates). */
const FIXTURES = join(__dirname, "../../src/features/parsing/fixtures/generic");

function doc(html: string): QueryRoot {
	return parseHTML(html).document as unknown as QueryRoot;
}

function fixture(name: string): QueryRoot {
	return doc(readFileSync(join(FIXTURES, name), "utf8"));
}

describe("detectOrderPage: platform order pages", () => {
	const positives: Array<[string, string, string, string]> = [
		[
			"shopify-account-order.html",
			"https://northwindcoffee.example/account/orders/8f1d2c3b4a5e6f708192a3b4c5d6e7f8",
			"shopify",
			"order_detail",
		],
		[
			"shopify-legacy-thankyou.html",
			"https://maple-leaf-tea.ca/12345678/checkouts/9f8e7d6c5b4a39281706f5e4d3c2b1a0/thank_you",
			"shopify",
			"order_confirmation",
		],
		[
			"woocommerce.html",
			"https://makersupplies.example.co.uk/checkout/order-received/5521/?key=wc_order_AbC123",
			"woocommerce",
			"order_confirmation",
		],
		[
			"woocommerce-block-confirmation.html",
			"https://werkbank.example.de/kasse/order-received/20417/?key=wc_order_Zx81PqLm",
			"woocommerce",
			"order_confirmation",
		],
		["woocommerce-view-order.html", "https://trailhead.example.com/my-account/view-order/8312/", "woocommerce", "order_detail"],
		[
			"prestashop-order-confirmation.html",
			"https://atelier-papier.example.fr/index.php?controller=order-confirmation&id_cart=2214&id_order=1842&key=x",
			"prestashop",
			"order_confirmation",
		],
		[
			"prestashop-order-detail.html",
			"https://brickandbolt.example.co.uk/index.php?controller=order-detail&id_order=377",
			"prestashop",
			"order_detail",
		],
		["magento-success.html", "https://shop.alpinegear.example/checkout/onepage/success/", "magento", "order_confirmation"],
		["magento-order-view.html", "https://shop.alpinegear.example/sales/order/view/order_id/4127/", "magento", "order_detail"],
		[
			"bigcommerce-order-confirmation.html",
			"https://ridgeback.example/checkout/order-confirmation/3071?t=4a5b",
			"bigcommerce",
			"order_confirmation",
		],
		[
			"bigcommerce-account-order.html",
			"https://ridgeback.example/account.php?action=view_order&order_id=3054",
			"bigcommerce",
			"order_detail",
		],
		[
			"medusa-order-confirmed.html",
			"https://kilnandclay.example/de/order/order_01JA8M3T2W7Z9K4N6P8R0S2V4X/confirmed",
			"medusa",
			"order_confirmation",
		],
	];
	for (const [file, url, platform, pageType] of positives) {
		it(`${file} → ${platform} ${pageType}`, () => {
			expect(detectOrderPage(url, fixture(file))).toEqual({ platform, pageType });
		});
	}

	it("recognizes Shopify checkout-extensibility thank-you and new customer account URLs", () => {
		const shopifyPage = doc(
			'<html><head><meta name="shopify-checkout-api-token" content="x"></head><body><main>Confirmation #ABC123XYZ</main></body></html>',
		);
		expect(detectOrderPage("https://shop.example/checkouts/cn/Z2NwLXVzLWVhc3Qx/thank-you", shopifyPage)).toEqual({
			platform: "shopify",
			pageType: "order_confirmation",
		});
		expect(detectOrderPage("https://shop.example/12345678/orders/0123456789abcdef0123456789abcdef", shopifyPage)).toEqual({
			platform: "shopify",
			pageType: "order_detail",
		});
		expect(detectOrderPage("https://shopify.com/61234567/account/orders/5612345678901", doc("<html></html>"))).toEqual({
			platform: "shopify",
			pageType: "order_detail",
		});
		// Same URL shape without any Shopify marker: not claimed.
		expect(detectOrderPage("https://shop.example/checkouts/cn/abc/thank-you", doc("<html><body>Thanks</body></html>"))).toBeNull();
	});
});

describe("detectOrderPage: never carts, products or unrelated pages", () => {
	it("rejects fixtures that are not orders", () => {
		expect(detectOrderPage("https://trailhead.example.com/cart/", fixture("woocommerce-cart.html"))).toBeNull();
		expect(detectOrderPage("https://gadget.example.net/products/logic-analyzer", fixture("product-page.html"))).toBeNull();
		expect(detectOrderPage("https://smallrobot.example.com/checkout/complete", fixture("text-confirmation.html"))).toBeNull();
	});

	it("rejects order markup on cart / product paths", () => {
		const woo = fixture("woocommerce.html");
		expect(detectOrderPage("https://makersupplies.example.co.uk/cart/", woo)).toBeNull();
		expect(detectOrderPage("https://shop.alpinegear.example/checkout/cart/", fixture("magento-success.html"))).toBeNull();
		expect(detectOrderPage("https://northwindcoffee.example/products/ethiopia-guji", fixture("shopify-account-order.html"))).toBeNull();
	});

	it("needs the platform's own combination of signals", () => {
		// A Shopify storefront page (markers, no order markup).
		const storefront = doc(
			'<html><head><link href="//shop.example/cdn/shop/t/3/assets/base.css" rel="stylesheet"></head><body><div class="shopify-section">Hi</div></body></html>',
		);
		expect(detectOrderPage("https://shop.example/", storefront)).toBeNull();
		expect(detectOrderPage("https://shop.example/account", storefront)).toBeNull();
		// Woo order number without the order details table (e.g. a theme snippet).
		expect(detectOrderPage("https://x.example/", doc('<mark class="order-number">12</mark>'))).toBeNull();
		// PrestaShop ids only count on the matching page body.
		expect(detectOrderPage("https://x.example/", doc('<body id="index"><li id="order-reference-value">X</li></body>'))).toBeNull();
		// BigCommerce account totals only on account.php?action=view_order.
		expect(
			detectOrderPage("https://x.example/account.php?action=order_status", doc('<dl class="account-orderTotal"></dl>')),
		).toBeNull();
		// Non-http(s) URLs.
		expect(detectOrderPage("chrome://extensions", fixture("woocommerce.html"))).toBeNull();
	});
});

describe("detector scope helpers", () => {
	it("excludes the server and dedicated store domains", () => {
		expect(isExcludedUrl("https://orders.example.com/orders/123", "https://orders.example.com")).toBe(true);
		expect(isExcludedUrl("http://orders.example.com:8080/x", "https://orders.example.com:8443/base")).toBe(true);
		expect(isExcludedUrl("https://www.amazon.com/gp/buy/thankyou", "https://orders.example.com")).toBe(true);
		expect(isExcludedUrl("https://order.ebay.com/ord/show?orderId=1", "")).toBe(true);
		expect(isExcludedUrl("https://shop.example/checkout/order-received/1/", "https://orders.example.com")).toBe(false);
		expect(isExcludedUrl("file:///tmp/x.html", "")).toBe(true);
		const excludes = detectorExcludeMatches("https://orders.example.com:8443/base");
		expect(excludes).toContain("*://orders.example.com/*");
		expect(excludes).toContain("*://*.amazon.com/*");
		expect(detectorExcludeMatches("")).not.toContain("*:///*");
	});

	it("only keeps watching order-ish URLs for late markup", () => {
		expect(mayBecomeOrderPage("https://ridgeback.example/checkout/order-confirmation/3071")).toBe(true);
		expect(mayBecomeOrderPage("https://kilnandclay.example/de/order/order_01/confirmed")).toBe(true);
		expect(mayBecomeOrderPage("https://blog.example/2026/10/hello-world")).toBe(false);
		expect(mayBecomeOrderPage("https://shop.example/cart")).toBe(false);
	});

	it("keys URLs without fragments or credentials", () => {
		expect(detectorUrlKey("https://u:p@shop.example/checkout/order-received/1/?key=k#top")).toBe(
			"https://shop.example/checkout/order-received/1/?key=k",
		);
	});
});

describe("stripForCapture", () => {
	it("keeps JSON-LD and order-data scripts, empties other scripts, styles and svg", () => {
		const html = [
			'<script type="application/ld+json">{"@type":"Order","orderNumber":"1"}</script>',
			'<script>Shopify.checkout = {"order_id":1};</script>',
			"<script>dataLayer.push({event:'purchase',ecommerce:{transaction_id:'T1',value:9}})</script>",
			'<script>var prestashop = {"customer":{"email":"a@b.c"},"static_token":"secret"};</script>',
			'<script src="https://cdn.shopify.com/x.js" async></script>',
			"<style>.a{color:red}</style>",
			'<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>',
			"<p>Order #1</p>",
		].join("");
		const out = stripForCapture(html);
		expect(out).toContain('{"@type":"Order","orderNumber":"1"}');
		expect(out).toContain("Shopify.checkout");
		expect(out).toContain("transaction_id:'T1'");
		expect(out).not.toContain("static_token");
		expect(out).toContain('<script src="https://cdn.shopify.com/x.js" async></script>');
		expect(out).toContain("<style></style>");
		expect(out).toContain('<svg viewBox="0 0 1 1"></svg>');
		expect(out).toContain("<p>Order #1</p>");
	});

	it("bounds the size", () => {
		expect(captureHtml(`<p>${"x".repeat(5000)}</p>`, 1000).length).toBeLessThanOrEqual(1000);
	});
});
