import { describe, expect, it } from "vitest";
import { suggestTaxTreatments, TAX_DISCLAIMER, treatmentHint } from "./tax";

const usSoleProp = {
	jurisdiction: "US" as const,
	businessType: "sole_prop" as const,
};
const base = {
	entityKind: "business" as const,
	profile: usSoleProp,
	category: null,
	items: [],
	amountMinor: 10_000,
	currency: "USD",
	usdFactor: 1,
};

describe("suggestTaxTreatments", () => {
	it("personal entity → not deductible", () => {
		const result = suggestTaxTreatments({ ...base, entityKind: "personal" });
		expect(result.suggestions[0]?.treatment).toBe("non_deductible");
		expect(result.disclaimer).toBe(TAX_DISCLAIMER);
	});

	it("component titles → supplies with Schedule C line 22", () => {
		const result = suggestTaxTreatments({
			...base,
			items: [
				{ title: "100x 0603 100nF capacitors", quantity: 1, totalMinor: 500 },
			],
		});
		const top = result.suggestions[0];
		expect(top?.treatment).toBe("supplies");
		expect(top?.hint).toBe("Schedule C line 22");
	});

	it("equipment over $2,500 → Section 179 candidate and large item flag", () => {
		const result = suggestTaxTreatments({
			...base,
			amountMinor: 320_000,
			items: [
				{
					title: "Rigol oscilloscope DS1104Z",
					quantity: 1,
					totalMinor: 320_000,
				},
			],
		});
		expect(result.suggestions.map((s) => s.treatment)).toContain("section_179");
		expect(result.largeItems).toHaveLength(1);
	});

	it("equipment at or under $2,500 → de minimis", () => {
		const result = suggestTaxTreatments({
			...base,
			items: [
				{ title: "Hakko soldering station", quantity: 1, totalMinor: 25_000 },
			],
		});
		expect(result.suggestions[0]?.treatment).toBe("de_minimis");
	});

	it("converts to USD for the threshold (EUR)", () => {
		const result = suggestTaxTreatments({
			...base,
			currency: "EUR",
			usdFactor: 1.08,
			items: [{ title: "Laptop", quantity: 1, totalMinor: 240_000 }],
		});
		// €2,400 ≈ $2,592 > $2,500
		expect(result.suggestions.map((s) => s.treatment)).toContain("section_179");
	});

	it("category drives the suggestion and flags expensed large items", () => {
		const result = suggestTaxTreatments({
			...base,
			category: { name: "Office supplies", code: "6100" },
			items: [{ title: "Standing frame XL", quantity: 1, totalMinor: 300_000 }],
		});
		expect(result.suggestions.map((s) => s.treatment)).toEqual(
			expect.arrayContaining(["office", "needs_review"]),
		);
	});

	it("falls back to other expense; never empty", () => {
		const result = suggestTaxTreatments({
			...base,
			items: [{ title: "Thing", quantity: 1, totalMinor: 100 }],
		});
		expect(result.suggestions[0]?.treatment).toBe("other_expense");
	});
});

describe("treatmentHint", () => {
	it("depends on profile", () => {
		expect(treatmentHint("supplies", usSoleProp, "business")).toBe(
			"Schedule C line 22",
		);
		expect(
			treatmentHint(
				"supplies",
				{ jurisdiction: "US", businessType: "s_corp" },
				"business",
			),
		).toBe("Form 1120-S deductions");
		expect(
			treatmentHint(
				"supplies",
				{ jurisdiction: "other", businessType: null },
				"business",
			),
		).toBeNull();
	});
});
