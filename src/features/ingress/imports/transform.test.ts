import { describe, expect, it } from "vitest";
import { buildPresetMapping, getPreset } from "./presets";
import {
	buildOrders,
	cleanCell,
	last4From,
	merchantSlug,
	orderIdFromFileName,
	parseQuantity,
	parseTracking,
} from "./transform";
import type { ImportMapping } from "./types";

function presetMapping(id: string, headers: string[]) {
	const preset = getPreset(id);
	if (!preset) throw new Error(`missing preset ${id}`);
	return buildPresetMapping(preset, headers);
}

describe("cell helpers", () => {
	it("cleans excel wrappers and n/a", () => {
		expect(cleanCell("'-1.50'")).toBe("-1.50");
		expect(cleanCell('="00123"')).toBe("00123");
		expect(cleanCell("'00123")).toBe("00123");
		expect(cleanCell("Not Available")).toBe("");
		expect(cleanCell(" N/A ")).toBe("");
	});
	it("parses quantities, last4, tracking", () => {
		expect(parseQuantity("1,000")).toBe(1000);
		expect(parseQuantity("2 pcs")).toBe(2);
		expect(last4From("Visa - 4821")).toBe("4821");
		expect(last4From("Mastercard ending in 1234")).toBe("1234");
		expect(last4From("Gift Certificate/Card")).toBeUndefined();
		expect(
			parseTracking("UPS(1Z999AA10123456784), AMZN_US(TBA123456789000)"),
		).toEqual([
			{ trackingNumber: "1Z999AA10123456784", carrier: "UPS" },
			{ trackingNumber: "TBA123456789000", carrier: "AMZN_US" },
		]);
		expect(parseTracking("9400111899223197428490", "USPS")).toEqual([
			{ trackingNumber: "9400111899223197428490", carrier: "USPS" },
		]);
		expect(parseTracking("Not Available")).toEqual([]);
	});
	it("file names and slugs", () => {
		expect(orderIdFromFileName("SalesOrder_84512345.csv")).toBe("84512345");
		expect(orderIdFromFileName("export.csv")).toBeUndefined();
		expect(merchantSlug("Acme Tools, Inc.")).toBe("acme-tools-inc");
		expect(merchantSlug("")).toBe("unknown-merchant");
	});
});

describe("buildOrders", () => {
	it("groups Amazon RMD rows and sums per-row money", () => {
		const headers = [
			"Order ID",
			"Order Date",
			"Currency",
			"Unit Price",
			"Shipping Charge",
			"Total Discounts",
			"Total Owed",
			"ASIN",
			"Quantity",
			"Payment Instrument Type",
			"Order Status",
			"Carrier Name & Tracking Number",
			"Product Name",
			"Total Amount Dummy",
		];
		const rows = [
			[
				"112-1234567-1234567",
				"2024-03-01T18:22:31Z",
				"USD",
				"10.00",
				"0",
				"'-1.00'",
				"20.33",
				"B000AAA",
				"2",
				"Visa - 4821",
				"Closed",
				"UPS(1Z999AA10123456784)",
				"Cable",
				"",
			],
			[
				"112-1234567-1234567",
				"2024-03-01T18:22:31Z",
				"USD",
				"5.50",
				"3.99",
				"0",
				"9.49",
				"B000BBB",
				"1",
				"Visa - 4821",
				"Closed",
				"UPS(1Z999AA10123456784)",
				"Adapter",
				"",
			],
			[
				"113-0000000-0000001",
				"2024-04-02T10:00:00Z",
				"USD",
				"7",
				"0",
				"0",
				"7.00",
				"B000CCC",
				"1",
				"",
				"Cancelled",
				"Not Available",
				"Thing",
				"",
			],
			["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
		];
		const mapping = presetMapping("amazon-order-history", headers);
		const result = buildOrders({ headers, rows, mapping });
		expect(result.errors).toEqual([]);
		expect(result.dataRows).toBe(3);
		expect(result.orders).toHaveLength(2);
		const [first, second] = result.orders;
		expect(first?.rows).toEqual([2, 3]);
		expect(first?.order).toMatchObject({
			externalOrderId: "112-1234567-1234567",
			orderDate: "2024-03-01",
			currency: "USD",
			merchantName: "Amazon",
			totalMinor: 2982,
			shippingMinor: 399,
			discountMinor: 100,
			status: "delivered",
			statusText: "Closed",
			paymentLast4: "4821",
			shipments: [{ trackingNumber: "1Z999AA10123456784", carrier: "UPS" }],
		});
		expect(first?.order.items).toEqual([
			{
				title: "Cable",
				sku: "B000AAA",
				quantity: 2,
				unitPriceMinor: 1000,
				totalMinor: 2000,
			},
			{
				title: "Adapter",
				sku: "B000BBB",
				quantity: 1,
				unitPriceMinor: 550,
				totalMinor: 550,
			},
		]);
		expect(second?.order.status).toBe("cancelled");
		expect(second?.order.shipments).toBeUndefined();
	});

	it("PayPal: only outgoing payments, absolute amounts, merchants kept apart", () => {
		const headers = [
			"Date",
			"Name",
			"Type",
			"Status",
			"Currency",
			"Gross",
			"Net",
			"Transaction ID",
			"Item Title",
			"Quantity",
		];
		const rows = [
			[
				"03/04/2024",
				"Acme Tools",
				"Express Checkout Payment",
				"Completed",
				"EUR",
				"-12,50",
				"-12,50",
				"7AB1",
				"Drill bits",
				"1",
			],
			[
				"03/05/2024",
				"Bob",
				"General Payment",
				"Completed",
				"EUR",
				"40,00",
				"40,00",
				"7AB2",
				"",
				"",
			],
			[
				"03/06/2024",
				"",
				"General Currency Conversion",
				"Completed",
				"EUR",
				"-12,50",
				"-12,50",
				"7AB3",
				"",
				"",
			],
			[
				"03/07/2024",
				"Other Shop",
				"Website Payment",
				"Completed",
				"EUR",
				"-3,00",
				"-3,00",
				"7AB4",
				"",
				"",
			],
		];
		const mapping = presetMapping("paypal-activity", headers);
		mapping.options.dayFirst = true;
		const result = buildOrders({ headers, rows, mapping });
		expect(result.skippedRows).toBe(2);
		expect(result.orders.map((o) => o.order.externalOrderId)).toEqual([
			"7AB1",
			"7AB4",
		]);
		expect(result.orders[0]?.order).toMatchObject({
			merchantName: "Acme Tools",
			totalMinor: 1250,
			currency: "EUR",
			orderDate: "2024-04-03",
			paymentHint: "PayPal",
		});
	});

	it("DigiKey: order id from the file name, line totals, computed total", () => {
		const headers = [
			"Index",
			"Quantity",
			"Part Number",
			"Manufacturer Part Number",
			"Description",
			"Customer Reference",
			"Unit Price",
			"Extended Price",
		];
		const rows = [
			[
				"1",
				"10",
				"311-10.0KCRCT-ND",
				"RC0603FR-0710KL",
				"RES 10K OHM 1% 1/10W 0603",
				"",
				"0.01000",
				"0.10",
			],
			[
				"2",
				"1",
				"1N4148FS-ND",
				"1N4148",
				"DIODE GEN PURP 100V 200MA DO35",
				"",
				"0.10000",
				"0.10",
			],
		];
		const mapping = presetMapping("digikey", headers);
		const result = buildOrders({
			headers,
			rows,
			mapping,
			fileName: "84512345.csv",
		});
		expect(result.orders).toHaveLength(1);
		const order = result.orders[0]?.order;
		expect(order?.externalOrderId).toBe("84512345");
		expect(order?.currency).toBe("USD");
		expect(order?.merchantName).toBe("DigiKey");
		expect(order?.items?.[0]).toMatchObject({
			sku: "311-10.0KCRCT-ND",
			quantity: 10,
			unitPriceMinor: 1,
			totalMinor: 10,
		});
		expect(order?.subtotalMinor).toBe(20);
		expect(order?.totalMinor).toBe(20);
		expect(result.orders[0]?.warnings).toContain(
			"Total computed from line items",
		);
	});

	it("generic: same order number at two merchants stays separate; missing ids are errors", () => {
		const headers = ["Order #", "Date", "Store", "Total"];
		const rows = [
			["#1001", "2024-01-02", "Shop A", "$10.00"],
			["1001", "2024-01-03", "Shop B", "$12.00"],
			["", "2024-01-04", "Shop C", "$1.00"],
			["1002", "not a date", "Shop A", "abc"],
		];
		const mapping = presetMapping("generic-orders", headers);
		const result = buildOrders({ headers, rows, mapping });
		expect(
			result.orders.map((o) => [o.order.externalOrderId, o.order.merchantName]),
		).toEqual([
			["1001", "Shop A"],
			["1001", "Shop B"],
			["1002", "Shop A"],
		]);
		expect(result.orders[0]?.order.currency).toBe("USD");
		expect(result.errors).toEqual([{ row: 4, message: "Missing order ID" }]);
		expect(result.orders[2]?.warnings.join(" ")).toMatch(/Unreadable date/);
		expect(result.orders[2]?.warnings.join(" ")).toMatch(/Unreadable total/);
	});

	it("constants act as defaults and synthetic ids are stable", () => {
		const headers = ["When", "Amount"];
		const mapping: ImportMapping = {
			source: "generic",
			fields: {
				orderDate: { column: "When" },
				total: { column: "Amount" },
				merchantName: { constant: "Corner Shop" },
			},
			options: { currency: "GBP" },
		};
		const rows = [["2024-02-02", "4.20"]];
		const a = buildOrders({ headers, rows, mapping });
		const b = buildOrders({ headers, rows, mapping });
		expect(a.orders[0]?.order).toMatchObject({
			merchantName: "Corner Shop",
			currency: "GBP",
			totalMinor: 420,
		});
		expect(a.orders[0]?.order.externalOrderId).toMatch(/^row-[0-9a-f]{8}$/);
		expect(a.orders[0]?.order.externalOrderId).toBe(
			b.orders[0]?.order.externalOrderId,
		);
	});
});
