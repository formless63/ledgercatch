import { describe, expect, it } from "vitest";
import {
	classifyUrl,
	extractOrderIdHints,
	findInvoiceCandidates,
	getStore,
	isIgnoredApiUrl,
	isOrderApiUrl,
	STORE_MATCHES,
	storeForUrl,
} from "@/lib/stores";

const cases: Array<[string, string, string]> = [
	// Amazon
	["https://www.amazon.com/your-orders/orders?timeFilter=year-2026&startIndex=10", "amazon", "order_list"],
	["https://www.amazon.com/gp/css/order-history?ref_=nav_orders_first", "amazon", "order_list"],
	["https://www.amazon.co.uk/gp/your-account/order-history", "amazon", "order_list"],
	["https://www.amazon.de/-/en/your-orders/orders", "amazon", "order_list"],
	["https://www.amazon.ca/gp/your-account/order-details?orderID=702-1234567-1234567", "amazon", "order_detail"],
	["https://www.amazon.com/your-orders/order-details?orderID=113-1234567-1234567", "amazon", "order_detail"],
	[
		"https://www.amazon.com/progress-tracker/package?orderId=113-1234567-1234567&shipmentId=X",
		"amazon",
		"order_detail",
	],
	["https://www.amazon.com/gp/css/summary/print.html?orderID=113-1234567-1234567", "amazon", "invoice"],
	[
		"https://www.amazon.com/gp/digital/your-account/order-summary.html?orderID=D01-1234567-1234567&print=1",
		"amazon",
		"invoice",
	],
	["https://www.amazon.de/documents/download/abc-123/invoice.pdf", "amazon", "invoice"],
	["https://www.amazon.com/gp/buy/thankyou/handlers/display.html?purchaseId=106-1", "amazon", "order_confirmation"],
	["https://www.amazon.com/dp/B000000000", "amazon", "unknown"],
	// AliExpress
	["https://www.aliexpress.com/p/order/index.html", "aliexpress", "order_list"],
	["https://www.aliexpress.us/p/order/detail.html?orderId=8123456789012345", "aliexpress", "order_detail"],
	["https://www.aliexpress.com/p/tracking/index.html?tradeOrderId=8123456789012345", "aliexpress", "order_detail"],
	["https://www.aliexpress.com/p/trade/confirm.html?x=1", "aliexpress", "unknown"],
	["https://www.aliexpress.com/item/1005001234567890.html", "aliexpress", "unknown"],
	// Alibaba
	["https://biz.alibaba.com/order/list.htm", "alibaba", "order_list"],
	["https://biz.alibaba.com/ta/detail.htm?orderId=268518575501029968", "alibaba", "order_detail"],
	["https://www.alibaba.com/product-detail/foo_123.html", "alibaba", "unknown"],
	// eBay
	["https://www.ebay.com/mye/myebay/purchase?filter=year_filter:CURRENT_YEAR", "ebay", "order_list"],
	["https://order.ebay.com/ord/show?orderId=12-34567-89012&purchaseOrderId=1#/", "ebay", "order_detail"],
	["https://order.ebay.co.uk/ord/show?orderId=12-34567-89012", "ebay", "order_detail"],
	["https://vod.ebay.com/vod/FetchOrderDetails?itemid=1&transid=2", "ebay", "order_detail"],
	["https://www.ebay.de/itm/1234567890", "ebay", "unknown"],
	// DigiKey
	["https://www.digikey.com/OrderHistory/List", "digikey", "order_list"],
	["https://www.digikey.ca/OrderHistory/ReviewOrder/81234567", "digikey", "order_detail"],
	["https://www.digikey.com/MyDigiKey/Orders", "digikey", "unknown"],
	// Mouser
	["https://www.mouser.com/OrderHistory/OrdersView.aspx", "mouser", "order_list"],
	["https://www.mouser.de/OrderHistory/OrderDetail.aspx?qs=abc", "mouser", "order_detail"],
	["https://www.mouser.com/ProductDetail/123", "mouser", "unknown"],
	// Generic
	["https://shop.example.com/checkout/thank-you", "generic", "unknown"],
	["chrome://extensions", "generic", "unknown"],
];

describe("classifyUrl", () => {
	it.each(cases)("%s -> %s / %s", (url, source, pageType) => {
		const c = classifyUrl(url);
		expect(c.source).toBe(source);
		expect(c.pageType).toBe(pageType);
	});

	it("does not match look-alike hosts", () => {
		expect(storeForUrl("https://notamazon.com/your-orders/orders")).toBeNull();
		expect(storeForUrl("https://amazon.com.evil.io/your-orders/orders")).toBeNull();
		expect(storeForUrl("https://amazon.com/your-orders/orders")?.id).toBe("amazon");
	});

	it("generates apex and wildcard match patterns", () => {
		expect(STORE_MATCHES).toContain("*://*.amazon.co.uk/*");
		expect(STORE_MATCHES).toContain("*://aliexpress.us/*");
	});
});

describe("isOrderApiUrl", () => {
	it("matches AliExpress mtop order APIs only", () => {
		const s = getStore("aliexpress");
		expect(isOrderApiUrl(s, "https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.list/1.0/?t=1")).toBe(
			true,
		);
		expect(isOrderApiUrl(s, "https://acs.aliexpress.com/h5/mtop.aliexpress.trade.buyer.order.detail/1.0/")).toBe(true);
		expect(isOrderApiUrl(s, "https://acs.aliexpress.com/h5/mtop.ae.ld.querydetail/1.0/")).toBe(true);
		expect(isOrderApiUrl(s, "https://acs.aliexpress.com/h5/mtop.aliexpress.recommend.feed/1.0/")).toBe(false);
	});
	it("matches the eBay purchase list JSON", () => {
		expect(
			isOrderApiUrl(
				getStore("ebay"),
				"https://www.ebay.com/mye/myebay/ajax/v2/purchase/mp/get?filter=year_filter:LAST_YEAR&page=2",
			),
		).toBe(true);
	});
	it("captures DigiKey shipment tracking APIs now parsed by the server", () => {
		const digikey = getStore("digikey");
		const url = "https://www.digikey.com/OrderHistory/api/ShipmentTracking/TrackingInfo?method=FedEx&tnum=123456789012";
		expect(isIgnoredApiUrl(digikey, url)).toBe(false);
		expect(isOrderApiUrl(digikey, url)).toBe(true);
	});
	it("matches DigiKey order-history XHRs", () => {
		expect(isOrderApiUrl(getStore("digikey"), "https://www.digikey.com/OrderHistory/api/orders?page=1")).toBe(true);
	});
	it("skips store APIs seen on order pages that never carry orders", () => {
		const ebay = getStore("ebay");
		const digikey = getStore("digikey");
		const mouser = getStore("mouser");
		expect(isOrderApiUrl(ebay, "https://www.ebay.com/mye/myebay/ajax/v2/purchase/mp/nuts/get?placement=1")).toBe(false);
		expect(isIgnoredApiUrl(ebay, "https://www.ebay.com/mye/myebay/ajax/watch/watchInline?itemId=1")).toBe(true);
		expect(isIgnoredApiUrl(ebay, "https://www.ebay.com/mye/myebay/ajax/summary/mp/nuts/get?placement=1")).toBe(true);
		expect(isIgnoredApiUrl(digikey, "https://www.digikey.com/OrderHistory/api/Phrases/GetCultureInfo")).toBe(true);
		expect(isIgnoredApiUrl(digikey, "https://www.digikey.com/OrderHistory/api/SeoUrl?currencyIso=USD")).toBe(true);
		expect(isOrderApiUrl(digikey, "https://www.digikey.com/OrderHistory/api/orders/9910000000000001")).toBe(true);
		expect(isIgnoredApiUrl(mouser, "https://www.mouser.com/api/OrderHistory/AnyOrderswithOrganization?_=1")).toBe(true);
		expect(isOrderApiUrl(mouser, "https://www.mouser.com/api/OrderHistory/Orders?cultureCode=en-US")).toBe(true);
	});
	it("defines JSON sniffers for stores with unknown endpoints", () => {
		expect(getStore("alibaba").jsonSniff?.test('{"data":{"orderId":"268518575501029968"}}')).toBe(true);
		expect(getStore("digikey").jsonSniff?.test('{"orders":[{"orderNumber":81234567}]}')).toBe(true);
		expect(getStore("aliexpress").jsonSniff).toBeUndefined();
	});
});

describe("extractOrderIdHints", () => {
	it("Amazon: takes IDs from order URLs and order-id widgets, never from free page text", () => {
		const s = getStore("amazon");
		const hints = extractOrderIdHints(s, {
			urls: [
				"https://www.amazon.com/gp/your-account/order-details?orderID=113-1111111-2222222",
				"https://www.amazon.com/telemetry?session-id=139-1234567-1234567",
			],
			text: "session 139-1234567-1234567 Order # 114-3333333-4444444",
			domText: "ORDER # 114-3333333-4444444\nORDER # D01-5555555-6666666",
		});
		expect(hints).toEqual(["113-1111111-2222222", "114-3333333-4444444", "D01-5555555-6666666"]);
	});

	it("eBay: dashed order numbers from text and URL", () => {
		const hints = extractOrderIdHints(getStore("ebay"), {
			urls: ["https://order.ebay.com/ord/show?orderId=12-34567-89012"],
			text: "Order number 12-34567-89012 and 23-45678-90123; phone 555-1234",
		});
		expect(hints).toEqual(["12-34567-89012", "23-45678-90123"]);
	});

	it("AliExpress: 15-19 digit IDs from URLs, labelled text and JSON (product IDs ignored)", () => {
		const hints = extractOrderIdHints(getStore("aliexpress"), {
			urls: [
				"https://www.aliexpress.com/p/order/detail.html?orderId=8123456789012345",
				"https://www.aliexpress.com/item/1005001234567890.html",
			],
			text: "Order ID: 8200000000000001 Copy",
			json: '{"orderId":"8300000000000002","productId":1005001234567890,"tradeOrderId":"8400000000000003"}',
		});
		expect(hints).toEqual(["8123456789012345", "8200000000000001", "8300000000000002", "8400000000000003"]);
	});

	it("DigiKey: labelled sales order numbers and ReviewOrder URLs", () => {
		const hints = extractOrderIdHints(getStore("digikey"), {
			urls: ["https://www.digikey.com/OrderHistory/ReviewOrder/9910000352694747"],
			text: "Sales Order # 81234567\nQty 1000",
			json: '{"orderNumber":81234568}',
		});
		expect(hints).toEqual(["9910000352694747", "81234567", "81234568"]);
	});

	it("Mouser: order-number widgets and labelled text", () => {
		const hints = extractOrderIdHints(getStore("mouser"), {
			text: "Web Order # 223344556",
			domText: "81005659",
		});
		expect(hints).toEqual(["223344556", "81005659"]);
	});

	it("returns nothing for generic pages and caps at 200", () => {
		expect(extractOrderIdHints(null, { text: "123-1234567-1234567" })).toEqual([]);
		const many = Array.from({ length: 300 }, (_, i) => `12-${String(10000 + i)}-00000`).join(" ");
		expect(extractOrderIdHints(getStore("ebay"), { text: many })).toHaveLength(200);
	});
});

describe("findInvoiceCandidates", () => {
	it("Amazon: classifies print, popover and PDF links and attaches order IDs", () => {
		const found = findInvoiceCandidates(getStore("amazon"), [
			{ href: "https://www.amazon.com/gp/css/summary/print.html?orderID=113-1111111-2222222", text: "View invoice" },
			{ href: "https://www.amazon.de/your-orders/invoice/popover?orderId=302-1111111-2222222", text: "Rechnung" },
			{ href: "https://www.amazon.de/documents/download/9f2/invoice.pdf", text: "Rechnung 1" },
			{ href: "https://www.amazon.com/dp/B000", text: "Some product" },
			{ href: "javascript:void(0)", text: "Invoice" },
		]);
		expect(found.map((f) => [f.format, f.externalOrderId])).toEqual([
			["html", "113-1111111-2222222"],
			["index", "302-1111111-2222222"],
			["pdf", undefined],
		]);
	});

	it("uses the single page order ID when the link has none, and dedupes by URL", () => {
		const found = findInvoiceCandidates(
			getStore("digikey"),
			[
				{ href: "https://www.digikey.com/x/invoice.pdf#a", text: "Invoice" },
				{ href: "https://www.digikey.com/x/invoice.pdf#b", text: "Invoice (again)" },
			],
			["81234567"],
		);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ format: "pdf", externalOrderId: "81234567" });
	});

	it("Mouser: ASP.NET lnkInvoice anchors count even when the text is a number", () => {
		const found = findInvoiceCandidates(getStore("mouser"), [
			{ href: "https://www.mouser.com/OrderHistory/x.aspx?qs=1", text: "12345678", id: "ctl00_grid_ctl02_lnkInvoice" },
		]);
		expect(found).toHaveLength(1);
	});
});

it("Alibaba ignores payment/trace/assistant APIs and supplier storefronts", () => {
	const store = getStore("alibaba");
	for (const url of [
		"https://cashier.alibaba.com/payment/ajaxQueryResult.json",
		"https://cashier.alibaba.com/payment/ajaxIndex.json",
		"https://biz.alibaba.com/list/ajax/ta/order/trace.json",
		"https://acs.h.alibaba.com/h5/mtop.alibaba.intl.camel.ai.tradeagent.query/1.0/",
	]) {
		expect(isIgnoredApiUrl(store, url)).toBe(true);
		expect(isOrderApiUrl(store, url)).toBe(false);
	}
	expect(classifyUrl("https://orderlist.en.alibaba.com/").pageType).toBe("unknown");
	expect(classifyUrl("https://example.en.alibaba.com/?orderlist=1").pageType).toBe("unknown");
});
