import { describe, expect, it } from "vitest";
import { STORE_IDS } from "#/shared/capture";
import { formatPriceInfoToMinor } from "./aliexpress";
import { amazonParser } from "./amazon";
import { digikeyParser } from "./digikey";
import { genericParser } from "./generic";
import { parseLooseJson } from "./json";
import { getParser, listParsers } from "./registry";
import { buildResult, cleanOrder } from "./result";
import {
	carrierForTrackingNumber,
	extractLast4,
	findTrackingNumbers,
	moneyAfterLabel,
} from "./text";
import type { ParserInput } from "./types";

function input(overrides: Partial<ParserInput>): ParserInput {
	return {
		source: "generic",
		kind: "html_snapshot",
		pageType: "unknown",
		pageUrl: "https://example.com/",
		pageTitle: "",
		capturedAt: "2026-10-08T00:00:00.000Z",
		orderIdHints: [],
		payload: { type: "html", html: "<html></html>" },
		...overrides,
	};
}

describe("registry", () => {
	it("has a versioned parser for every store id", () => {
		for (const id of STORE_IDS) {
			const parser = getParser(id);
			expect(parser?.source).toBe(id);
			expect(parser?.version).toBeGreaterThanOrEqual(1);
		}
		expect(listParsers()).toHaveLength(STORE_IDS.length);
	});
});

describe("robustness", () => {
	const garbage: ParserInput["payload"][] = [
		{ type: "html", html: "" },
		{ type: "html", html: "<html><body><div class='order-card'><span>broken" },
		{
			type: "html",
			html: "<script>dataLayer.push({transaction_id: foo()})</script>",
		},
		{ type: "json", requestUrl: "https://example.com/api", body: null },
		{ type: "json", requestUrl: "https://example.com/api", body: "not json (" },
		{
			type: "json",
			requestUrl: "https://example.com/api",
			body: { data: { data: { pc_om_list_order_1: { fields: null } } } },
		},
		{
			type: "json",
			requestUrl: "https://example.com/api",
			body: [[[{ orderNumber: {} }]]],
		},
		{ type: "text", text: "hello" },
	];
	for (const parser of listParsers()) {
		it(`${parser.source} never throws and returns a valid outcome`, () => {
			for (const payload of garbage) {
				const result = parser.parse(input({ source: parser.source, payload }));
				expect(["orders", "no_orders", "unsupported"]).toContain(
					result.outcome,
				);
			}
		});
	}
});

describe("amazon specifics", () => {
	it("adds gift-card payments back onto the grand total", () => {
		const html = `<div id="orderDetails">
			<div data-component="orderDate"><span>June 6, 2026</span></div>
			<div data-component="orderId"><span>D01-1000111-2000222</span></div>
			<div data-component="chargeSummary"><ul>
				<li><div class="a-row od-line-item-row"><div class="od-line-item-row-label">Item(s) Subtotal:</div><div class="od-line-item-row-content">$2.73</div></div></li>
				<li><div class="a-row od-line-item-row"><div class="od-line-item-row-label">Tax Collected:</div><div class="od-line-item-row-content">$0.18</div></div></li>
				<li><div class="a-row od-line-item-row"><div class="od-line-item-row-label">Gift Card:</div><div class="od-line-item-row-content">-$2.90</div></div></li>
				<li><div class="a-row od-line-item-row"><div class="od-line-item-row-label">Total for this Order:</div><div class="od-line-item-row-content">$0.01</div></div></li>
			</ul></div></div>`;
		const result = amazonParser.parse(
			input({
				source: "amazon",
				pageType: "order_detail",
				pageUrl:
					"https://www.amazon.com/your-orders/order-details?orderID=D01-1000111-2000222",
				payload: { type: "html", html },
			}),
		);
		expect(result).toMatchObject({
			outcome: "orders",
			orders: [
				{
					externalOrderId: "D01-1000111-2000222",
					subtotalMinor: 273,
					taxMinor: 18,
					totalMinor: 291,
					paymentHint: "Amazon gift card",
				},
			],
		});
	});

	it("never takes the session-id lookalike as an order id", () => {
		const html = `<html><body><script>ue_sid='139-1234567-1234567'</script><div class="order-card"><div class="yohtmlc-order-id"></div></div></body></html>`;
		const result = amazonParser.parse(
			input({
				source: "amazon",
				pageType: "order_list",
				payload: { type: "html", html },
			}),
		);
		expect(result.outcome).toBe("no_orders");
	});
});

describe("digikey ids above 2^53", () => {
	it("skips an unsafe numeric order number when no hint matches", () => {
		// JSON.parse mirrors how the wire value loses precision.
		const body = JSON.parse(
			'[{"orderNumber": 9910000352694747, "dateEntered": "2026-10-01T00:00:00Z", "currencyIso": "USD"}]',
		);
		const result = digikeyParser.parse(
			input({
				source: "digikey",
				kind: "api_json",
				payload: {
					type: "json",
					requestUrl: "https://www.digikey.com/x",
					body,
				},
			}),
		);
		expect(result.outcome).toBe("no_orders");
	});
});

describe("generic text payloads", () => {
	it("only claims page text when id, total and date are all present", () => {
		const text =
			"Thank you for your order!\nOrder #W-99812\nOrder date: Oct 3, 2026\nSubtotal $10.00\nTotal $12.50";
		const ok = genericParser.parse(
			input({
				kind: "page_text",
				pageType: "order_confirmation",
				payload: { type: "text", text },
			}),
		);
		expect(ok).toMatchObject({
			outcome: "orders",
			orders: [
				{
					externalOrderId: "W-99812",
					orderDate: "2026-10-03",
					totalMinor: 1250,
					subtotalMinor: 1000,
				},
			],
		});
		const vague = genericParser.parse(
			input({
				kind: "page_text",
				payload: { type: "text", text: "Total $12.50" },
			}),
		);
		expect(vague.outcome).toBe("no_orders");
	});
});

describe("helpers", () => {
	it("formatPriceInfoToMinor", () => {
		expect(formatPriceInfoToMinor("R$126,59|126|59", "BRL")).toBe(12659);
		expect(formatPriceInfoToMinor("￥1,280|1280|0", "JPY")).toBe(1280);
		expect(formatPriceInfoToMinor("US $0.5|0|5", "USD")).toBe(50);
		expect(formatPriceInfoToMinor("bad", "USD")).toBeUndefined();
	});

	it("parseLooseJson", () => {
		expect(
			parseLooseJson("{a: 'x', \"b\": [1, 2,], c: true, d: undefined}"),
		).toEqual({ a: "x", b: [1, 2], c: true, d: null });
		expect(parseLooseJson('{a: "it\'s", b: \'say "hi"\'}')).toEqual({
			a: "it's",
			b: 'say "hi"',
		});
		expect(parseLooseJson("{a: someVar}")).toBeUndefined();
		expect(parseLooseJson("{a: fn()}")).toBeUndefined();
	});

	it("moneyAfterLabel ignores values that belong to a later label", () => {
		const text = "Subtotal: $10.00\nShipping: FREE\nTax: $0.80\nTotal: $10.80";
		expect(
			moneyAfterLabel(text, /shipping:?/i, { allowFree: true, currency: "USD" })
				?.amountMinor,
		).toBe(0);
		expect(
			moneyAfterLabel(text, /(?<!sub)total:?/i, { last: true })?.amountMinor,
		).toBe(1080);
		expect(
			moneyAfterLabel("Discount: -€2,50", /discount:?/i)?.amountMinor,
		).toBe(-250);
	});

	it("extractLast4 / findTrackingNumbers", () => {
		expect(extractLast4("Visa ending in 4821")).toBe("4821");
		expect(extractLast4("Mastercard •••• 5310")).toBe("5310");
		expect(extractLast4("Visa ****1234")).toBe("1234");
		expect(extractLast4("Mastercard mit der Endung 5310")).toBe("5310");
		expect(extractLast4("Order 1234")).toBeUndefined();
		expect(
			findTrackingNumbers("UPS 1Z999AA10123456784 and LP00612345678901"),
		).toEqual([
			{ carrier: "UPS", trackingNumber: "1Z999AA10123456784" },
			{ carrier: "Cainiao", trackingNumber: "LP00612345678901" },
		]);
	});

	it("buildResult merges fragments of the same order", () => {
		const result = buildResult(
			[
				{
					externalOrderId: "1",
					totalMinor: 100,
					items: [{ title: "a", quantity: 1 }],
					itemsPartial: true,
				},
				{
					externalOrderId: "1",
					currency: "USD",
					items: [
						{ title: "a", quantity: 1 },
						{ title: "b", quantity: 2 },
					],
				},
				{ externalOrderId: "  " },
			],
			[],
			"none",
		);
		expect(result).toEqual({
			outcome: "orders",
			warnings: [],
			orders: [
				{
					externalOrderId: "1",
					totalMinor: 100,
					currency: "USD",
					items: [
						{ title: "a", quantity: 1 },
						{ title: "b", quantity: 2 },
					],
				},
			],
		});
	});
});

describe("shipment normalization", () => {
	it("infers carriers from unambiguous tracking formats", () => {
		expect(carrierForTrackingNumber("1Z999AA10123456784")).toBe("UPS");
		expect(carrierForTrackingNumber("9400 1000 0000 0000 0000 00")).toBe(
			"USPS",
		);
		expect(carrierForTrackingNumber("LZ123456789US")).toBe("USPS");
		expect(carrierForTrackingNumber("TBA123456789012")).toBe(
			"Amazon Logistics",
		);
		expect(carrierForTrackingNumber("123456789012")).toBeUndefined();
	});

	it("fills carrier and event dates from status text", () => {
		const order = cleanOrder({
			externalOrderId: "1",
			shipments: [
				{
					trackingNumber: "1Z999AA10123456784",
					status: "Delivered on Fri, Aug 14, 2026",
				},
				{ trackingNumber: "ABC123", status: "Shipped on Sep 2, 2026 via DHL" },
				{
					trackingNumber: "LZ123456789US",
					carrier: "Kept",
					status: "In transit",
				},
			],
		});
		expect(order?.shipments).toEqual([
			{
				trackingNumber: "1Z999AA10123456784",
				carrier: "UPS",
				status: "Delivered on Fri, Aug 14, 2026",
				deliveredAt: "2026-08-14",
			},
			{
				trackingNumber: "ABC123",
				carrier: "DHL",
				status: "Shipped on Sep 2, 2026 via DHL",
				shippedAt: "2026-09-02",
			},
			{
				trackingNumber: "LZ123456789US",
				carrier: "Kept",
				status: "In transit",
			},
		]);
	});
});
