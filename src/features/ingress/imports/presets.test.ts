import { describe, expect, it } from "vitest";
import {
	buildPresetMapping,
	detectMapping,
	detectPreset,
	getPreset,
	headerSignature,
	normalizeHeader,
} from "./presets";
import { importMappingSchema } from "./types";

const AMAZON_RMD = [
	"Website",
	"Order ID",
	"Order Date",
	"Purchase Order Number",
	"Currency",
	"Unit Price",
	"Unit Price Tax",
	"Shipping Charge",
	"Total Discounts",
	"Total Owed",
	"Shipment Item Subtotal",
	"Shipment Item Subtotal Tax",
	"ASIN",
	"Product Condition",
	"Quantity",
	"Payment Instrument Type",
	"Order Status",
	"Shipment Status",
	"Ship Date",
	"Shipping Option",
	"Shipping Address",
	"Billing Address",
	"Carrier Name & Tracking Number",
	"Product Name",
	"Gift Message",
];
const ALIEXPRESS = [
	"Order Date",
	"Order ID",
	"Title",
	"Qty",
	"Price",
	"Store",
	"Product ID",
	"SKU ID",
	"Attributes",
	"Price Info",
	"Price Cost",
	"Currency",
	"Status",
	"Product Url",
	"Product Image Url",
	"Store Url",
	"Tags",
	"Tracking Number",
	"AliExpress Tracking Number",
	"Tracking Carrier",
	"Shipment Address",
	"Tracking Timeline",
];
const PAYPAL = [
	"Date",
	"Time",
	"TimeZone",
	"Name",
	"Type",
	"Status",
	"Currency",
	"Gross",
	"Fee",
	"Net",
	"From Email Address",
	"To Email Address",
	"Transaction ID",
	"Item Title",
	"Item ID",
	"Shipping and Handling Amount",
	"Sales Tax",
	"Quantity",
	"Balance",
];
const DIGIKEY = [
	"Index",
	"Quantity",
	"Part Number",
	"Manufacturer Part Number",
	"Description",
	"Customer Reference",
	"Available",
	"Backorder",
	"Unit Price",
	"Extended Price",
];
const MOUSER = [
	"Line",
	"Mouser #",
	"Mfr. #",
	"Customer #",
	"Desc.",
	"Order Qty.",
	"Price (EUR)",
	"Ext.: (EUR)",
];

describe("normalizeHeader", () => {
	it("collapses punctuation and case", () => {
		expect(normalizeHeader("﻿Carrier Name & Tracking Number")).toBe(
			"carrier name tracking number",
		);
		expect(normalizeHeader("Ext.: (USD)")).toBe("ext usd");
		expect(normalizeHeader("Mfr. #")).toBe("mfr");
	});
	it("signature ignores order", () => {
		expect(headerSignature(["B", "a"])).toBe(headerSignature(["A", "b"]));
	});
});

describe("detectPreset", () => {
	it.each([
		[AMAZON_RMD, "amazon-order-history"],
		[ALIEXPRESS, "aliexpress-shopper-inventory"],
		[PAYPAL, "paypal-activity"],
		[DIGIKEY, "digikey"],
		[MOUSER, "mouser"],
		[
			[
				"Order Date",
				"Order ID",
				"Title",
				"ASIN/ISBN",
				"Purchase Price Per Unit",
				"Quantity",
				"Item Total",
			],
			"amazon-legacy-items",
		],
		[["Order #", "Date", "Store", "Total"], "generic-orders"],
		[["Order", "Date", "Product", "SKU", "Qty", "Unit price"], "generic-items"],
	])("%#", (headers, id) => {
		expect(detectPreset(headers).preset.id).toBe(id);
	});

	it("builds a valid Amazon mapping", () => {
		const preset = getPreset("amazon-order-history");
		if (!preset) throw new Error("missing preset");
		const mapping = buildPresetMapping(preset, AMAZON_RMD);
		expect(importMappingSchema.safeParse(mapping).success).toBe(true);
		expect(mapping.source).toBe("amazon");
		expect(mapping.fields.total?.column).toBe("Total Owed");
		expect(mapping.fields.trackingNumber?.column).toBe(
			"Carrier Name & Tracking Number",
		);
		expect(mapping.fields.merchantName?.constant).toBe("Amazon");
		expect(mapping.options.sumFields).toContain("total");
	});

	it("takes currency from Mouser price headers", () => {
		const mapping = buildPresetMapping(
			getPreset("mouser") as NonNullable<ReturnType<typeof getPreset>>,
			MOUSER,
		);
		expect(mapping.options.currency).toBe("EUR");
		expect(mapping.fields.unitPrice?.column).toBe("Price (EUR)");
		expect(mapping.fields.lineTotal?.column).toBe("Ext.: (EUR)");
		expect(mapping.fields.externalOrderId?.fromFileName).toBe(true);
	});

	it("resolves PayPal filter columns", () => {
		const mapping = buildPresetMapping(
			getPreset("paypal-activity") as NonNullable<ReturnType<typeof getPreset>>,
			PAYPAL,
		);
		expect(mapping.options.filters?.map((f) => f.column)).toEqual([
			"Gross",
			"Type",
			"Status",
		]);
	});
});

describe("detectMapping", () => {
	const parse = (value: unknown) => {
		const r = importMappingSchema.safeParse(value);
		return r.success ? r.data : null;
	};
	it("prefers a saved template with the same header signature", () => {
		const mapping = {
			source: "generic",
			fields: { externalOrderId: { column: "Ref" }, total: { column: "Sum" } },
			options: {},
		};
		const result = detectMapping(
			["Ref", "Sum", "When"],
			[
				{
					id: "t1",
					name: "My shop",
					source: "generic",
					headerSignature: headerSignature(["Sum", "When", "Ref"]),
					mapping,
				},
			],
			parse,
		);
		expect(result.detected).toEqual({
			kind: "template",
			id: "t1",
			name: "My shop",
		});
		expect(result.templateId).toBe("t1");
	});
	it("falls back to presets", () => {
		const result = detectMapping(AMAZON_RMD, [], parse);
		expect(result.detected.kind).toBe("preset");
		expect(result.detected.id).toBe("amazon-order-history");
	});
});
