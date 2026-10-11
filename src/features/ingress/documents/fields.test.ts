import { describe, expect, it } from "vitest";
import {
	applyTemplate,
	buildTemplate,
	extractFields,
	extractionToParsedOrder,
	findMoney,
	isConfidentExtraction,
	locateValue,
	merchantOrderUrl,
	merchantSlug,
	parseFieldValue,
} from "./fields";
import {
	buildLines,
	type DocumentLayout,
	type LayoutWord,
	layoutFromText,
	textOfRefs,
} from "./layout";

/** Synthetic page: each segment is [x, y, text, size?]; words get 0.55em/char. */
function page(
	segments: Array<[number, number, string, number?]>,
	width = 612,
	height = 792,
) {
	const words: LayoutWord[] = [];
	for (const [x0, y, text, size = 10] of segments) {
		let x = x0;
		for (const token of text.split(" ")) {
			const w = token.length * size * 0.55;
			words.push({ text: token, bbox: [x, y, x + w, y + size] });
			x += w + size * 0.3;
		}
	}
	return { width, height, words };
}

const layoutOf = (...pages: ReturnType<typeof page>[]): DocumentLayout => ({
	pages,
	ocrSource: "pdf-text",
});

const invoice = layoutOf(
	page([
		[40, 40, "Northwind Electronics", 22],
		[400, 44, "INVOICE", 16],
		[40, 90, "123 Market Street, Springfield"],
		[380, 90, "Invoice #: NW-20931"],
		[380, 106, "Invoice Date: March 14, 2026"],
		[380, 122, "Due Date: April 14, 2026"],
		[40, 200, "Description"],
		[330, 200, "Qty"],
		[400, 200, "Unit Price"],
		[500, 200, "Amount"],
		[40, 220, "USB-C cable 2m"],
		[335, 220, "2"],
		[400, 220, "$12.50"],
		[500, 220, "$25.00"],
		[40, 236, "Soldering station"],
		[335, 236, "1"],
		[400, 236, "$89.99"],
		[500, 236, "$89.99"],
		[40, 250, "with stand"],
		[400, 300, "Subtotal"],
		[500, 300, "$114.99"],
		[400, 316, "Shipping"],
		[500, 316, "$7.95"],
		[400, 332, "Sales Tax"],
		[500, 332, "$9.20"],
		[400, 348, "Discount"],
		[500, 348, "-$5.00"],
		[400, 364, "Total"],
		[500, 364, "$127.14"],
		[40, 420, "Paid with Visa ending in 4821"],
	]),
);

describe("findMoney", () => {
	it("finds marked and fractional amounts, skipping ids, dates and percents", () => {
		const hits = findMoney(
			"INV-1001 on 03.10.2026: 8.25% of $1,234.56 and 12,50 €",
		);
		expect(hits.map((h) => h.minor)).toEqual([123456, 1250]);
		expect(hits[1]?.currency).toBe("EUR");
	});
	it("reads negatives and parentheses", () => {
		expect(findMoney("-$5.00")[0]?.minor).toBe(-500);
		expect(findMoney("($5.00)")[0]?.minor).toBe(-500);
	});
	it("does not merge a quantity with the following price", () => {
		expect(findMoney("2 12.50").map((h) => h.minor)).toEqual([1250]);
	});
});

describe("extractFields — label proximity", () => {
	const result = extractFields(invoice);
	const f = result.fields;

	it("picks totals by label on the same row", () => {
		expect(f.subtotal?.value).toBe("114.99");
		expect(f.shipping?.value).toBe("7.95");
		expect(f.tax?.value).toBe("9.20");
		expect(f.discount?.value).toBe("5.00");
		expect(f.total?.value).toBe("127.14");
		// Sum is consistent → high confidence.
		expect(f.total?.confidence).toBeGreaterThanOrEqual(0.95);
		expect(textOfRefs(invoice, f.total?.refs ?? [])).toBe("$127.14");
	});

	it("reads order number, the labeled (not due) date, card and merchant", () => {
		expect(f.externalOrderId?.value).toBe("NW-20931");
		expect(textOfRefs(invoice, f.externalOrderId?.refs ?? [])).toBe("NW-20931");
		expect(f.orderDate?.value).toBe("2026-03-14");
		expect(textOfRefs(invoice, f.orderDate?.refs ?? [])).toBe("March 14, 2026");
		expect(f.paymentLast4?.value).toBe("4821");
		expect(f.merchantName?.value).toBe("Northwind Electronics");
		expect(f.currency?.value).toBe("USD");
	});

	it("detects the line-item table with continuation rows", () => {
		expect(result.items).toHaveLength(2);
		expect(result.items[0]).toMatchObject({
			title: "USB-C cable 2m",
			quantity: "2",
			unitPrice: "12.50",
			total: "25.00",
		});
		expect(result.items[1]?.title).toBe("Soldering station with stand");
	});

	it("is confident enough to create the order", () => {
		expect(isConfidentExtraction(result)).toBe(true);
		const order = extractionToParsedOrder(result, {});
		expect(order).toMatchObject({
			externalOrderId: "NW-20931",
			merchantName: "Northwind Electronics",
			orderUrl: "upload://northwind-electronics/",
			totalMinor: 12714,
			discountMinor: 500,
			currency: "USD",
		});
		expect(order?.items?.[0]?.totalMinor).toBe(2500);
	});
});

describe("extractFields — values below labels", () => {
	const layout = layoutOf(
		page([
			[40, 40, "Contoso Ltd", 18],
			[40, 100, "Order Number"],
			[200, 100, "Order Date"],
			[40, 114, "C-77812"],
			[200, 114, "14.03.2026"],
			[420, 400, "Amount due"],
			[420, 414, "€ 1.299,00"],
		]),
	);
	const { fields } = extractFields(layout);
	it("reads stacked label/value pairs", () => {
		expect(fields.externalOrderId?.value).toBe("C-77812");
		expect(fields.orderDate?.value).toBe("2026-03-14");
		expect(fields.total?.value).toBe("1299.00");
		expect(fields.currency?.value).toBe("EUR");
	});
});

describe("extractFields — ambiguous text", () => {
	it("does not take a shipping address as shipping cost, nor a tax id as tax", () => {
		const layout = layoutOf(
			page([
				[40, 100, "Shipping address: 12 Elm St"],
				[40, 116, "VAT number: DE123456789"],
				[40, 132, "Order #A12345"],
				[300, 300, "Total $10.00"],
			]),
		);
		const { fields } = extractFields(layout);
		expect(fields.shipping).toBeUndefined();
		expect(fields.tax).toBeUndefined();
		expect(fields.externalOrderId?.value).toBe("A12345");
		expect(fields.total?.value).toBe("10.00");
	});

	it("falls back to plain text without geometry", () => {
		const layout = layoutFromText(
			"ACME CORP\nOrder #: 5521\nGrand Total: $42.00\nVisa **** 1111",
		);
		const { fields } = extractFields(layout);
		expect(fields.externalOrderId?.value).toBe("5521");
		expect(fields.total?.value).toBe("42.00");
		expect(fields.paymentLast4?.value).toBe("1111");
		expect(layout.synthetic).toBe(true);
	});
});

describe("selection parsing", () => {
	it("parses money/date/order/last4 selections", () => {
		expect(parseFieldValue("total", "Total: USD 1,020.5")).toBe("1020.50");
		expect(parseFieldValue("discount", "-$3.00")).toBe("3.00");
		expect(parseFieldValue("shipping", "FREE")).toBe("0.00");
		expect(parseFieldValue("orderDate", "Mar 3, 2026")).toBe("2026-03-03");
		expect(parseFieldValue("orderDate", "03/04/2026", { dayFirst: true })).toBe(
			"2026-04-03",
		);
		expect(parseFieldValue("externalOrderId", "Order # 114-555")).toBe(
			"114-555",
		);
		expect(parseFieldValue("paymentLast4", "Mastercard •••• 9012")).toBe(
			"9012",
		);
		expect(parseFieldValue("currency", "€")).toBe("EUR");
	});
});

describe("templates and value location", () => {
	it("re-reads fields from saved merchant regions", () => {
		const { fields } = extractFields(invoice);
		const template = buildTemplate(invoice, "Northwind Electronics", {
			externalOrderId: fields.externalOrderId?.refs,
			total: fields.total?.refs,
		});
		const next = layoutOf(
			page([
				[40, 40, "Northwind Electronics", 22],
				[380, 90, "Invoice #: NW-30000"],
				[500, 364, "$55.10"],
			]),
		);
		const guesses = applyTemplate(next, template);
		expect(guesses.externalOrderId?.value).toBe("NW-30000");
		expect(guesses.total?.value).toBe("55.10");
		expect(guesses.total?.via).toBe("template");
	});

	it("locates AI values on the page", () => {
		const lines = buildLines(invoice);
		const refs = locateValue(invoice, "total", "127.14", lines);
		expect(textOfRefs(invoice, refs)).toBe("$127.14");
		const id = locateValue(invoice, "externalOrderId", "NW-20931", lines);
		expect(textOfRefs(invoice, id)).toBe("NW-20931");
	});

	it("slugs merchants into stable pseudo hosts", () => {
		expect(merchantSlug("Café & Co. GmbH")).toBe("cafe-and-co-gmbh");
		expect(new URL(merchantOrderUrl("Café & Co. GmbH")).hostname).toBe(
			"cafe-and-co-gmbh",
		);
	});
});
