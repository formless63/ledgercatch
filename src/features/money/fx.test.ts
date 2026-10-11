import { describe, expect, it } from "vitest";
import {
	conversionMemo,
	convertMinorWithRate,
	formatRate,
	minorToDecimal,
	parseEcbXml,
	parseFrankfurterJson,
	RateTable,
} from "./fx";

const ECB = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube>
<Cube time='2026-10-03'>
<Cube currency='USD' rate='1.0812'/><Cube currency='JPY' rate='161.20'/><Cube currency='KWD' rate='0.3321'/>
</Cube>
<Cube time='2026-10-02'><Cube currency='USD' rate='1.0800'/></Cube>
</Cube></gesmes:Envelope>`;

describe("feeds", () => {
	it("parses ECB XML", () => {
		const rows = parseEcbXml(ECB);
		expect(rows).toHaveLength(4);
		expect(rows[0]).toEqual({
			date: "2026-10-03",
			base: "EUR",
			quote: "USD",
			rate: 1.0812,
			source: "ecb",
		});
	});
	it("parses Frankfurter single day and series", () => {
		expect(
			parseFrankfurterJson({
				base: "EUR",
				date: "2026-10-03",
				rates: { USD: 1.08 },
			}),
		).toHaveLength(1);
		const series = parseFrankfurterJson({
			base: "EUR",
			start_date: "2026-10-01",
			rates: {
				"2026-10-01": { USD: 1.07, GBP: 0.85 },
				"2026-10-02": { USD: 1.08 },
			},
		});
		expect(series).toHaveLength(3);
		expect(series[0]?.source).toBe("frankfurter");
	});
});

describe("RateTable", () => {
	const table = new RateTable(parseEcbXml(ECB));
	it("direct, inverse and cross rates", () => {
		expect(table.rate("EUR", "USD", "2026-10-03")?.rate).toBe(1.0812);
		expect(table.rate("USD", "EUR", "2026-10-03")?.rate).toBeCloseTo(
			1 / 1.0812,
			10,
		);
		expect(table.rate("JPY", "USD", "2026-10-03")?.rate).toBeCloseTo(
			1.0812 / 161.2,
			10,
		);
	});
	it("looks back over weekends but not forever", () => {
		const sunday = table.rate("EUR", "USD", "2026-10-05");
		expect(sunday?.date).toBe("2026-10-03");
		expect(table.rate("EUR", "USD", "2026-10-20")).toBeNull();
		expect(table.rate("EUR", "USD", "2026-09-01")).toBeNull();
	});
});

describe("conversion with exponents", () => {
	it("2 → 2 decimals", () => {
		expect(convertMinorWithRate(4697, "EUR", "USD", 1.0812)).toBe(5078);
		expect(convertMinorWithRate(-4697, "EUR", "USD", 1.0812)).toBe(-5078);
	});
	it("0 → 2 decimals (JPY → USD)", () => {
		// ¥1200 × (1.0812 / 161.2) = $8.0486 → 805 cents
		expect(convertMinorWithRate(1200, "JPY", "USD", 1.0812 / 161.2)).toBe(805);
	});
	it("2 → 0 and 2 → 3 decimals", () => {
		expect(convertMinorWithRate(1000, "USD", "JPY", 149.09)).toBe(1491);
		expect(convertMinorWithRate(1000, "EUR", "KWD", 0.3321)).toBe(3321);
	});
	it("identity and decimals", () => {
		expect(convertMinorWithRate(123, "USD", "usd", 2)).toBe(123);
		expect(minorToDecimal(4697, "EUR")).toBe("46.97");
		expect(minorToDecimal(5, "USD")).toBe("0.05");
		expect(minorToDecimal(-1200, "JPY")).toBe("-1200");
		expect(minorToDecimal(1234, "KWD")).toBe("1.234");
	});
	it("memo", () => {
		expect(
			conversionMemo({
				amountMinor: 4697,
				from: "EUR",
				rate: { rate: 1.0812, date: "2026-10-03", source: "ecb" },
			}),
		).toBe("converted from EUR 46.97 @ 1.0812 (ECB 2026-10-03)");
		expect(formatRate(0.0067071)).toBe("0.006707");
	});
});
