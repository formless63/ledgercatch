import { describe, expect, it } from "vitest";
import {
	detectCurrency,
	minorDigits,
	parseDecimalString,
	parseMoney,
	toMinor,
} from "./money";

describe("parseMoney", () => {
	it.each([
		["$1,234.56", 123456, "USD"],
		["US $12.34", 1234, "USD"],
		["US$ 12.34", 1234, "USD"],
		["USD 7.00", 700, "USD"],
		["€ 1.234,56", 123456, "EUR"],
		["1.234,56 €", 123456, "EUR"],
		["12,34 €", 1234, "EUR"],
		["EUR 9,99", 999, "EUR"],
		["£19.99", 1999, "GBP"],
		["C$ 45.00", 4500, "CAD"],
		["CA$45.00", 4500, "CAD"],
		["C $45.00", 4500, "CAD"],
		["AU $3.50", 350, "AUD"],
		["¥1,280", 1280, "JPY"],
		["￥ 980", 980, "JPY"],
		["₩12,000", 12000, "KRW"],
		["RM 25.90", 2590, "MYR"],
		["1 234,56 zł", 123456, "PLN"],
		["1 234,56 zł", 123456, "PLN"],
		["R$126,59", 12659, "BRL"],
		["CHF 1'234.50", 123450, "CHF"],
		["Kč 1 299", 129900, "CZK"],
		["₹2,49,999.00", 24999900, "INR"],
		["$0.99", 99, "USD"],
		["$12", 1200, "USD"],
		["-$5.83", -583, "USD"],
		["−€2,00", -200, "EUR"],
		["($4.00)", -400, "USD"],
		["Total: $28.80", 2880, "USD"],
	])("%s → %i %s", (text, minor, currency) => {
		expect(parseMoney(text)).toEqual({ amountMinor: minor, currency });
	});

	it("uses the hint for ambiguous symbols and bare numbers", () => {
		expect(parseMoney("$12.34", { currency: "CAD" })).toEqual({
			amountMinor: 1234,
			currency: "CAD",
		});
		expect(parseMoney("¥99", { currency: "CNY" })).toEqual({
			amountMinor: 9900,
			currency: "CNY",
		});
		expect(parseMoney("12.50", { currency: "usd" })).toEqual({
			amountMinor: 1250,
			currency: "USD",
		});
		expect(parseMoney("12.50")).toEqual({
			amountMinor: 1250,
			currency: undefined,
		});
		// An explicit marker beats the hint.
		expect(parseMoney("US $1.00", { currency: "CAD" })).toEqual({
			amountMinor: 100,
			currency: "USD",
		});
	});

	it("handles free, numbers and junk", () => {
		expect(parseMoney("FREE", { allowFree: true, currency: "USD" })).toEqual({
			amountMinor: 0,
			currency: "USD",
		});
		expect(parseMoney("FREE")).toBeUndefined();
		expect(parseMoney(12.345, { currency: "USD" })).toEqual({
			amountMinor: 1235,
			currency: "USD",
		});
		expect(parseMoney(1280, { currency: "JPY" })).toEqual({
			amountMinor: 1280,
			currency: "JPY",
		});
		expect(parseMoney("")).toBeUndefined();
		expect(parseMoney("n/a")).toBeUndefined();
		expect(parseMoney(undefined)).toBeUndefined();
	});

	it("does not read neighbouring numbers into the amount", () => {
		expect(parseMoney("US $1.23x2")?.amountMinor).toBe(123);
		expect(parseMoney("$12.34 2 items")?.amountMinor).toBe(1234);
		expect(parseMoney("US $12.34 - US $15.00")?.amountMinor).toBe(1234);
	});
});

describe("helpers", () => {
	it("parseDecimalString", () => {
		expect(parseDecimalString("1,234")).toBe("1234");
		expect(parseDecimalString("1.234")).toBe("1234");
		expect(parseDecimalString("1.234", 3)).toBe("1.234");
		expect(parseDecimalString("1.234.567,8")).toBe("1234567.8");
		expect(parseDecimalString("0.12345")).toBe("0.12345");
		expect(parseDecimalString("abc")).toBeUndefined();
	});
	it("toMinor / minorDigits", () => {
		expect(toMinor(0.1 + 0.2, "USD")).toBe(30);
		expect(toMinor("19.995", "USD")).toBe(2000);
		expect(toMinor(1500, "JPY")).toBe(1500);
		expect(toMinor(1.5, "KWD")).toBe(1500);
		expect(minorDigits("krw")).toBe(0);
		expect(minorDigits(undefined)).toBe(2);
	});
	it("detectCurrency", () => {
		expect(detectCurrency("Gesamt: 12,00 €")).toBe("EUR");
		expect(detectCurrency("$5")).toBe("USD");
		expect(detectCurrency("$5", "AUD")).toBe("AUD");
		expect(detectCurrency("249 kr", "NOK")).toBe("NOK");
		expect(detectCurrency("nothing")).toBeUndefined();
	});
});

import { redactForAi } from "./ai-extract.server";

describe("redactForAi", () => {
	it("removes emails, phones and long card numbers but keeps order ids", () => {
		const out = redactForAi(
			"Order #113-4829104-5562210 for jane@example.com, call (555) 123-4567, card 4111 1111 1111 4821",
		);
		expect(out).toContain("113-4829104-5562210");
		expect(out).not.toContain("jane@example.com");
		expect(out).toContain("[phone]");
		expect(out).toContain("•••4821");
	});
});
