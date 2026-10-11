import { describe, expect, it } from "vitest";
import { digikeyParser } from "./digikey";
import type { ParserInput } from "./types";

const input: ParserInput = {
	source: "digikey",
	kind: "api_json",
	pageType: "order_detail",
	pageUrl: "https://www.digikey.com/OrderHistory/ReviewOrder/9007199254740993",
	pageTitle: "",
	capturedAt: "2026-08-12T12:00:00Z",
	orderIdHints: [],
	payload: {
		type: "json",
		requestUrl:
			"https://www.digikey.com/OrderHistory/api/ShipmentTracking/TrackingInfo?method=UPS&tnum=1Z999AA10123456784",
		body: { success: true, status: "On the way" },
	},
};

describe("DigiKey ShipmentTracking", () => {
	it("uses request tracking/carrier fields when omitted from the body without changing order status", () => {
		const result = digikeyParser.parse(input);
		expect(result.outcome).toBe("orders");
		if (result.outcome !== "orders") return;
		expect(result.orders[0]).toMatchObject({
			externalOrderId: "9007199254740993",
			shipments: [
				{
					trackingNumber: "1Z999AA10123456784",
					carrier: "UPS",
					status: "On the way",
				},
			],
		});
		expect(result.orders[0]).not.toHaveProperty("status");
	});
	it("does not guess which order owns a shipment on a list page", () => {
		expect(
			digikeyParser.parse({
				...input,
				pageUrl: "https://www.digikey.com/OrderHistory/List",
				orderIdHints: ["12345678", "87654321"],
			}).outcome,
		).toBe("no_orders");
	});
	it("does not create orders for failed tracking responses", () => {
		if (input.payload.type !== "json") return;
		expect(
			digikeyParser.parse({
				...input,
				payload: {
					...input.payload,
					body: { success: false, status: "Error" },
				},
			}).outcome,
		).toBe("no_orders");
	});
});
