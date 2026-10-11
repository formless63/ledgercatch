import { describe, expect, it } from "vitest";
import {
	merchantSimilarity,
	normalizeMerchant,
	orderMerchantKey,
} from "./merchant";

describe("normalizeMerchant", () => {
	it.each([
		["AMZN Mktp US*2K4AB12C3", "amazon"],
		["Amazon.com*RT4KL0PQ2 Amzn.com/billWA", "amazon"],
		["ALIEXPRESS.COM LUXEMBOURG LU", "aliexpress"],
		["PAYPAL *EBAY O*12-34567-89012", "ebay"],
		["EBAY O*09-12345-67890", "ebay"],
		["DIGIKEY ELECTRONICS 800-344-4539 MN", "digikey"],
		["DIGI-KEY CORP", "digikey"],
		["MOUSER ELECTRONICS INC", "mouser"],
	])("%s → %s", (input, key) => {
		const result = normalizeMerchant(input);
		expect(result.key).toBe(key);
		expect(result.known).toBe(true);
	});

	it("strips processor prefixes, refs and locations", () => {
		expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE #12 OAKLAND CA").key).toBe(
			"blue bottle coffee",
		);
		expect(normalizeMerchant("PAYPAL *ACMEWIDGETS 4029357733").key).toBe(
			"acmewidgets",
		);
		expect(normalizeMerchant("").key).toBe("");
	});

	it("order keys use the store id or merchant name", () => {
		expect(orderMerchantKey("amazon", null)).toBe("amazon");
		expect(orderMerchantKey("generic", "Acme Widgets LLC")).toBe(
			"acme widgets",
		);
	});

	it("similarity", () => {
		expect(merchantSimilarity("amazon", "amazon")).toBe(1);
		expect(merchantSimilarity("acmewidgets", "acme widgets")).toBe(1);
		expect(merchantSimilarity("acme", "acme widgets")).toBeGreaterThan(0.7);
		expect(merchantSimilarity("amazon", "mouser")).toBeLessThan(0.3);
	});
});
