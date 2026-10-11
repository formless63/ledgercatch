import { describe, expect, it } from "vitest";
import {
	MAX_ENRICHMENT_ATTEMPTS,
	missingParts,
	orderDetailUrl,
	REQUEUE_COOLDOWN_MS,
	shouldRequeue,
} from "./urls";

describe("orderDetailUrl", () => {
	it("builds Amazon URLs with the marketplace from order URL or currency", () => {
		expect(orderDetailUrl("amazon", "112-1234567-1234567")).toBe(
			"https://www.amazon.com/gp/your-account/order-details?orderID=112-1234567-1234567",
		);
		expect(
			orderDetailUrl("amazon", "302-1234567-1234567", {
				orderUrl:
					"https://www.amazon.de/your-orders/order-details?orderID=302-1234567-1234567",
				currency: "USD",
			}),
		).toContain("https://www.amazon.de/");
		expect(
			orderDetailUrl("amazon", "702-1234567-1234567", { currency: "CAD" }),
		).toContain("https://www.amazon.ca/");
		expect(
			orderDetailUrl("amazon", "202-1234567-1234567", { currency: "gbp" }),
		).toContain("https://www.amazon.co.uk/");
		expect(orderDetailUrl("amazon", "not-an-id")).toBeNull();
	});
	it("builds AliExpress, eBay, DigiKey and Alibaba URLs", () => {
		expect(orderDetailUrl("aliexpress", "8123456789012345")).toBe(
			"https://www.aliexpress.com/p/order/detail.html?orderId=8123456789012345",
		);
		expect(orderDetailUrl("ebay", "12-34567-89012", { currency: "EUR" })).toBe(
			"https://order.ebay.de/ord/show?orderId=12-34567-89012",
		);
		expect(orderDetailUrl("digikey", "87654321")).toBe(
			"https://www.digikey.com/OrderHistory/ReviewOrder/87654321",
		);
		expect(orderDetailUrl("digikey", "87654321", { currency: "CAD" })).toBe(
			"https://www.digikey.ca/OrderHistory/ReviewOrder/87654321",
		);
		expect(orderDetailUrl("alibaba", "123456789012")).toBe(
			"https://biz.alibaba.com/ta/detail.htm?orderId=123456789012",
		);
	});
	it("only uses a recorded detail URL for Mouser and nothing for generic", () => {
		expect(orderDetailUrl("mouser", "81005659")).toBeNull();
		const url = "https://www.mouser.com/OrderHistory/OrderDetail.aspx?qs=abc";
		expect(orderDetailUrl("mouser", "81005659", { orderUrl: url })).toBe(url);
		expect(
			orderDetailUrl("mouser", "81005659", {
				orderUrl: "https://evil.example/OrderDetail",
			}),
		).toBeNull();
		expect(orderDetailUrl("generic", "1001")).toBeNull();
	});
});

describe("missingParts", () => {
	const complete = {
		itemCount: 2,
		itemsWithoutPrice: 0,
		totalMinor: 1000,
		taxMinor: 80,
		hasPayment: true,
		hasInvoice: true,
	};
	it("is empty for a complete order", () => {
		expect(missingParts(complete)).toEqual([]);
	});
	it("lists what an email-only order lacks", () => {
		expect(
			missingParts({
				...complete,
				itemCount: 0,
				taxMinor: null,
				hasPayment: false,
				hasInvoice: false,
			}),
		).toEqual(["items", "tax", "payment", "invoice"]);
		expect(missingParts({ ...complete, itemsWithoutPrice: 1 })).toEqual([
			"item prices",
		]);
	});
});

describe("shouldRequeue", () => {
	const now = new Date("2026-10-01T12:00:00Z");
	it("never touches pending or claimed tasks", () => {
		expect(
			shouldRequeue({ status: "pending", attempts: 0, finishedAt: null }, now),
		).toBe(false);
		expect(
			shouldRequeue({ status: "claimed", attempts: 1, finishedAt: null }, now),
		).toBe(false);
	});
	it("reopens finished tasks after the cooldown while attempts remain", () => {
		const old = new Date(now.getTime() - REQUEUE_COOLDOWN_MS - 1);
		const recent = new Date(now.getTime() - 60_000);
		expect(
			shouldRequeue({ status: "done", attempts: 1, finishedAt: old }, now),
		).toBe(true);
		expect(
			shouldRequeue(
				{ status: "skipped", attempts: 1, finishedAt: recent },
				now,
			),
		).toBe(false);
		expect(
			shouldRequeue(
				{
					status: "failed",
					attempts: MAX_ENRICHMENT_ATTEMPTS,
					finishedAt: old,
				},
				now,
			),
		).toBe(false);
	});
});
