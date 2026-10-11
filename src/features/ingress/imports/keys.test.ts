import { describe, expect, it } from "vitest";
import { importSourceRef, stableStringify } from "./keys.server";

describe("import keys", () => {
	it("stable stringify sorts keys and drops undefined", () => {
		expect(stableStringify({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe(
			'{"a":[1,{"c":2}],"b":1}',
		);
	});
	it("same order → same key; changed content → new key", () => {
		const order = { externalOrderId: "1", totalMinor: 100, currency: "USD" };
		const a = importSourceRef("amazon", "import://amazon", order);
		const b = importSourceRef("amazon", "import://amazon", {
			currency: "USD",
			totalMinor: 100,
			externalOrderId: "1",
		});
		expect(a).toBe(b);
		expect(a).toMatch(/^import:[0-9a-f]{48}$/);
		expect(
			importSourceRef("amazon", "import://amazon", {
				...order,
				status: "delivered",
			}),
		).not.toBe(a);
		expect(importSourceRef("generic", "import://shop-a", order)).not.toBe(
			importSourceRef("generic", "import://shop-b", order),
		);
	});
});
