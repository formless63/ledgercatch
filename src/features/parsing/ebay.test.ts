import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ebayParser } from "./ebay";

it("uses only shipment tracking information as carrier evidence", () => {
	const html = readFileSync(
		new URL("./fixtures/ebay/order-details-carriers.html", import.meta.url),
		"utf8",
	);
	const result = ebayParser.parse({
		source: "ebay",
		kind: "html_snapshot",
		pageType: "order_detail",
		pageUrl: "https://order.ebay.com/ord/show?orderId=14-10000-20001",
		pageTitle: "Order details",
		capturedAt: "2026-10-10T12:00:00Z",
		orderIdHints: [],
		payload: { type: "html", html },
	});
	expect(result.outcome).toBe("orders");
	if (result.outcome !== "orders") throw new Error(result.outcome);
	expect(result.orders[0]?.shipments).toEqual([
		{ trackingNumber: "123456789012", carrier: "FedEx" },
		{ trackingNumber: "D100000000001", carrier: "DHL eCommerce" },
		{ trackingNumber: "223456789012" },
		{ trackingNumber: "D100000000002" },
	]);
});

it("does not split checkout-wide tax and shipping across sibling orders", () => {
	const html = readFileSync(
		new URL("./fixtures/ebay/order-details-combined.html", import.meta.url),
		"utf8",
	);
	const result = ebayParser.parse({
		source: "ebay",
		kind: "html_snapshot",
		pageType: "order_detail",
		pageUrl: "https://order.ebay.com/ord/show?orderId=25-55555-66667",
		pageTitle: "Order details",
		capturedAt: "2026-10-10T12:00:00Z",
		orderIdHints: [],
		payload: { type: "html", html },
	});
	expect(result.outcome).toBe("orders");
	if (result.outcome !== "orders") throw new Error(result.outcome);
	for (const order of result.orders) {
		expect(order).not.toHaveProperty("shippingMinor");
		expect(order).not.toHaveProperty("taxMinor");
		expect(new URL(order.orderUrl ?? "").searchParams.get("orderId")).toBe(
			order.externalOrderId,
		);
		expect(order.documentLinks).toEqual([
			{ kind: "receipt", url: order.orderUrl },
		]);
	}
});

it("does not reuse the page id or shared total for an unidentified sibling", () => {
	const result = ebayParser.parse({
		source: "ebay",
		kind: "html_snapshot",
		pageType: "order_detail",
		pageUrl: "https://order.ebay.com/ord/show?orderId=14-10000-20002",
		pageTitle: "Order details",
		capturedAt: "2026-10-10T12:00:00Z",
		orderIdHints: [],
		payload: {
			type: "html",
			html: `<html><body><div class="order-box"><div class="order-info"><dl><dt>Order number</dt><dd>14-10000-20002</dd><dt>Total</dt><dd>$10.00</dd></dl></div></div><div class="order-box"><div class="order-info"><dl><dt>Total</dt><dd>$20.00</dd></dl></div></div><div class="summary-region"><dl><dt>Tax</dt><dd>$2.00</dd><dt>Total</dt><dd>$32.00</dd></dl></div></body></html>`,
		},
	});
	expect(result.outcome).toBe("orders");
	if (result.outcome !== "orders") throw new Error(result.outcome);
	expect(result.orders).toHaveLength(1);
	expect(result.orders[0]?.totalMinor).toBe(1000);
	expect(result.orders[0]).not.toHaveProperty("taxMinor");
});

it.each([
	{ capturedAt: "2026-10-08T21:30:00-04:00", expected: "2026-10-08" },
	{ capturedAt: "2026-10-09T02:00:00+05:30", expected: "2026-10-09" },
	{
		capturedAt: "2026-10-09T01:30:00Z",
		capturedLocalDate: "2026-10-08",
		expected: "2026-10-08",
	},
	{ capturedAt: "2026-10-09T01:30:00Z", expected: undefined },
	{
		capturedAt: "2026-10-09T01:30:00Z",
		capturedLocalDate: "2026-10-08",
		pageDate: "Oct 7, 2026",
		expected: "2026-10-07",
	},
])("uses purchase date or captured local date: $capturedAt / $pageDate", ({
	capturedAt,
	capturedLocalDate,
	pageDate,
	expected,
}) => {
	let html = readFileSync(
		new URL("./fixtures/ebay/checkout-success.html", import.meta.url),
		"utf8",
	);
	if (pageDate)
		html = html.replace(
			"</body>",
			`<div class="success-evo--order-summary-item"><div class="success-evo--order-summary-item-label">Order date</div><div class="success-evo--order-summary-item-description">${pageDate}</div></div></body>`,
		);
	const result = ebayParser.parse({
		source: "ebay",
		kind: "html_snapshot",
		pageType: "order_confirmation",
		pageUrl: "https://pay.ebay.com/rxo?action=success",
		pageTitle: "Checkout",
		capturedAt,
		capturedLocalDate,
		orderIdHints: [],
		payload: { type: "html", html },
	});
	expect(result.outcome).toBe("orders");
	if (result.outcome !== "orders") throw new Error(result.outcome);
	if (expected) expect(result.orders[0]?.orderDate).toBe(expected);
	else expect(result.orders[0]).not.toHaveProperty("orderDate");
});
