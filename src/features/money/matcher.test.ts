import { describe, expect, it } from "vitest";
import { convertMinorWithRate, RateTable } from "./fx";
import {
	findSplitSubset,
	type MatchOrder,
	type MatchTransaction,
	matchTransactions,
	scoreChargeMatch,
} from "./matcher";

const tx = (
	over: Partial<MatchTransaction> & { id: string },
): MatchTransaction => ({
	date: "2026-10-03",
	amountMinor: 4697,
	currency: "USD",
	merchantKey: "amazon",
	paymentMethodId: "card1",
	kind: "charge",
	...over,
});
const order = (over: Partial<MatchOrder> & { id: string }): MatchOrder => ({
	date: "2026-10-02",
	totalMinor: 4697,
	currency: "USD",
	merchantKey: "amazon",
	paymentMethodId: "card1",
	status: "delivered",
	...over,
});

describe("scoreChargeMatch", () => {
	it("scores a perfect match near 1", () => {
		const s = scoreChargeMatch(tx({ id: "t" }), order({ id: "o" }));
		expect(s?.score).toBeGreaterThan(0.95);
		expect(s?.reasons).toContain("same card");
	});
	it("vetoes a different known card and out-of-window dates", () => {
		expect(
			scoreChargeMatch(
				tx({ id: "t", paymentMethodId: "card2" }),
				order({ id: "o" }),
			),
		).toBeNull();
		expect(
			scoreChargeMatch(tx({ id: "t", date: "2026-10-12" }), order({ id: "o" })),
		).toBeNull();
		expect(
			scoreChargeMatch(tx({ id: "t", date: "2026-09-29" }), order({ id: "o" })),
		).toBeNull();
		expect(
			scoreChargeMatch(tx({ id: "t", amountMinor: 4700 }), order({ id: "o" })),
		).toBeNull();
	});
	it("allows unknown card with lower score", () => {
		const s = scoreChargeMatch(
			tx({ id: "t", paymentMethodId: null }),
			order({ id: "o" }),
		);
		expect(s?.score).toBeCloseTo(0.9, 2);
	});
	it("matches foreign currency within FX tolerance", () => {
		const table = new RateTable([
			{
				date: "2026-10-02",
				base: "EUR",
				quote: "USD",
				rate: 1.0812,
				source: "ecb",
			},
		]);
		const convert = (a: number, f: string, t: string, d: string) => {
			const r = table.rate(f, t, d);
			return r ? convertMinorWithRate(a, f, t, r.rate) : null;
		};
		// EUR 46.97 → USD 50.78; card charged 51.90 (2.2% FX fee)
		const s = scoreChargeMatch(
			tx({ id: "t", amountMinor: 5190, merchantKey: "aliexpress" }),
			order({ id: "o", currency: "EUR", merchantKey: "aliexpress" }),
			convert,
		);
		expect(s).not.toBeNull();
		expect(s?.reasons.join(" ")).toMatch(/after FX/);
		expect(
			scoreChargeMatch(
				tx({ id: "t", amountMinor: 6000 }),
				order({ id: "o", currency: "EUR" }),
				convert,
			),
		).toBeNull();
	});
});

describe("matchTransactions", () => {
	it("assigns greedily one-to-one", () => {
		const result = matchTransactions({
			transactions: [
				tx({ id: "t1" }),
				tx({ id: "t2", amountMinor: 1000, merchantKey: "mouser" }),
			],
			orders: [
				order({ id: "o1" }),
				order({ id: "o2", totalMinor: 1000, merchantKey: "mouser" }),
			],
		});
		expect(result.map((s) => [s.transactionIds[0], s.orderId])).toEqual([
			["t1", "o1"],
			["t2", "o2"],
		]);
	});

	it("respects rejected pairs and orders already charged", () => {
		const base = {
			transactions: [tx({ id: "t1" })],
			orders: [order({ id: "o1" })],
		};
		expect(
			matchTransactions({ ...base, rejected: new Set(["t1|o1"]) }),
		).toHaveLength(0);
		expect(
			matchTransactions({ ...base, ordersWithCharge: new Set(["o1"]) }),
		).toHaveLength(0);
	});

	it("finds split shipments summing to the order total", () => {
		const result = matchTransactions({
			transactions: [
				tx({ id: "a", amountMinor: 2000, date: "2026-10-03" }),
				tx({ id: "b", amountMinor: 1500, date: "2026-10-09" }),
				tx({ id: "c", amountMinor: 1197, date: "2026-10-15" }),
				tx({ id: "x", amountMinor: 999, merchantKey: "starbucks" }),
			],
			orders: [order({ id: "o1", totalMinor: 4697 })],
		});
		const split = result.find((s) => s.kind === "split");
		expect(split?.orderId).toBe("o1");
		expect(split?.transactionIds.sort()).toEqual(["a", "b", "c"]);
	});

	it("matches refunds to orders (full and per item)", () => {
		const result = matchTransactions({
			transactions: [
				tx({
					id: "r1",
					amountMinor: -4697,
					date: "2026-10-20",
					kind: "credit",
				}),
				tx({
					id: "r2",
					amountMinor: -1299,
					date: "2026-10-25",
					kind: "credit",
					merchantKey: "digikey",
				}),
			],
			orders: [
				order({ id: "o1", status: "returned" }),
				order({
					id: "o2",
					merchantKey: "digikey",
					totalMinor: 5000,
					itemTotals: [1299, 3701],
				}),
			],
			ordersWithCharge: new Set(["o1", "o2"]),
		});
		const refunds = result.filter((s) => s.kind === "refund");
		expect(refunds.map((s) => [s.transactionIds[0], s.orderId])).toEqual([
			["r1", "o1"],
			["r2", "o2"],
		]);
		expect(refunds[0]?.reasons).toContain("full refund");
		expect(refunds[1]?.reasons).toContain("refund of one item");
	});

	it("flags ambiguous candidates with a lower score", () => {
		const result = matchTransactions({
			transactions: [tx({ id: "t1" })],
			orders: [order({ id: "o1" }), order({ id: "o2" })],
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.reasons.join(" ")).toMatch(/similar candidates/);
	});
});

describe("findSplitSubset", () => {
	it("returns null when nothing sums", () => {
		expect(
			findSplitSubset(
				[
					{ id: "a", amountMinor: 1 },
					{ id: "b", amountMinor: 2 },
				],
				10,
				0,
			),
		).toBeNull();
		expect(
			findSplitSubset(
				[
					{ id: "a", amountMinor: 4 },
					{ id: "b", amountMinor: 6 },
				],
				10,
				0,
			),
		).toEqual(["a", "b"]);
	});
});
