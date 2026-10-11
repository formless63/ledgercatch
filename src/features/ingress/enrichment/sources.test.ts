import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));
vi.mock("#/features/ledger/documents.server", () => ({
	readDocumentBytes: vi.fn(),
	storeDocument: vi.fn(),
}));
vi.mock("../captures.server", () => ({ createServerCapture: vi.fn() }));

const { mapSalesOrder, mapDigikeyStatus, salesOrdersOf } = await import(
	"../sources/digikey.server"
);
const { documentsQuery, guessDocumentKind, guessStore, relativeNext } =
	await import("../sources/paperless.server");

const salesOrder = {
	CustomerId: 1234567,
	SalesOrderId: 87654321,
	Status: { SalesOrderStatus: "Shipped", ShortDescription: "Shipped" },
	PurchaseOrder: "PO-42",
	TotalPrice: 23.6,
	DateEntered: "2026-09-01T10:00:00Z",
	OrderNumber: 5551234,
	Currency: "USD",
	LineItems: [
		{
			DetailId: 1,
			TotalPrice: 5.78,
			DigiKeyProductNumber: "296-1234-1-ND",
			ManufacturerProductNumber: "LM358DR",
			Description: "IC OPAMP GP 2 CIRCUIT 8SOIC",
			QuantityOrdered: 10,
			UnitPrice: 57800,
			ItemShipments: [
				{ TrackingNumber: "1Z999", ShippedDate: "2026-09-02T00:00:00Z" },
			],
		},
		{
			DetailId: 2,
			TotalPrice: 12.5,
			DigiKeyProductNumber: "311-10.0KCRCT-ND",
			Description: "RES 10K OHM 0603",
			QuantityOrdered: 100,
			UnitPrice: 0.125,
			ItemShipments: [{ TrackingNumber: "1Z999" }],
		},
	],
};

describe("DigiKey v4 mapping", () => {
	it("maps a sales order to a ParsedOrder", () => {
		const order = mapSalesOrder(salesOrder);
		expect(order).toMatchObject({
			externalOrderId: "87654321",
			orderUrl: "https://www.digikey.com/OrderHistory/ReviewOrder/87654321",
			orderDate: "2026-09-01",
			status: "shipped",
			currency: "USD",
			totalMinor: 2360,
			subtotalMinor: 1828,
			paymentHint: "PO PO-42",
		});
		expect(order?.items?.[0]).toMatchObject({
			sku: "296-1234-1-ND",
			quantity: 10,
			totalMinor: 578,
			unitPriceMinor: 58,
		});
		expect(order?.items?.[1]?.unitPriceMinor).toBe(13);
		expect(order?.shipments).toEqual([
			{ trackingNumber: "1Z999", shippedAt: "2026-09-02", etaText: undefined },
		]);
	});
	it("flattens /orders responses into sales orders", () => {
		const pairs = salesOrdersOf({
			TotalOrders: 1,
			Orders: [
				{
					OrderNumber: 1,
					Currency: "EUR",
					SalesOrders: [salesOrder, { SalesOrderId: 11112222 }],
				},
			],
		});
		expect(pairs).toHaveLength(2);
		expect(mapSalesOrder(pairs[1]?.so ?? {}, pairs[1]?.parent)?.currency).toBe(
			"EUR",
		);
		expect(salesOrdersOf(salesOrder)).toHaveLength(1);
	});
	it("maps statuses", () => {
		expect(mapDigikeyStatus("Canceled")).toBe("cancelled");
		expect(mapDigikeyStatus("ProcessingPartialShipment")).toBe("processing");
		expect(mapDigikeyStatus("Received")).toBe("placed");
		expect(mapDigikeyStatus(undefined)).toBe("unknown");
	});
});

describe("Paperless helpers", () => {
	it("builds the documents query", () => {
		const q = documentsQuery(
			{
				baseUrl: "https://p.example",
				tag: "order",
				pushInvoices: false,
				correspondentFilter: "Digi",
			},
			"2026-09-01T00:00:00Z",
		);
		const params = new URLSearchParams(q.split("?")[1]);
		expect(q.startsWith("/api/documents/?")).toBe(true);
		expect(params.get("tags__name__iexact")).toBe("order");
		expect(params.get("correspondent__name__icontains")).toBe("Digi");
		expect(params.get("modified__gt")).toBe("2026-09-01T00:00:00Z");
		expect(params.get("ordering")).toBe("modified");
	});
	it("keeps only path and query of DRF next links", () => {
		expect(
			relativeNext(
				"http://internal:8000/api/documents/?page=2&tags__name__iexact=order",
			),
		).toBe("/api/documents/?page=2&tags__name__iexact=order");
		expect(relativeNext(null)).toBeNull();
	});
	it("guesses store and document kind", () => {
		expect(guessStore({ correspondent: "Digi-Key Electronics" })).toBe(
			"digikey",
		);
		expect(
			guessStore({
				title: "Scan",
				content: "Thank you for shopping at Amazon.com",
			}),
		).toBe("amazon");
		expect(guessStore({ title: "Hardware store" })).toBe("generic");
		expect(guessDocumentKind({ title: "Receipt 2026-09" })).toBe("receipt");
		expect(guessDocumentKind({ documentType: "Invoice" })).toBe("invoice");
	});
});
