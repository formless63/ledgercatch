import { describe, expect, it } from "vitest";
import {
	addMonths,
	assetsToCsv,
	warrantyExpiry,
	warrantyState,
} from "./assets";
import {
	type DuplicateSubject,
	detectDuplicates,
	scorePair,
	suggestKeep,
} from "./duplicates";
import {
	groupPurchases,
	itemKey,
	likeEscape,
	normalizeTitle,
	type PurchaseRow,
	priceSeries,
	searchTerms,
	unitPrice,
} from "./items";
import {
	claimDecision,
	impliedRefundFromParsedOrder,
	netAllocations,
	refundStatusFromText,
} from "./refunds";
import {
	detectCarrier,
	normalizeTrackingState,
	trackingLink,
} from "./tracking";
import {
	parseSeventeenTrackInfo,
	seventeenTrackProvider,
} from "./tracking-provider";

const alloc = (id: string, entityId: string, amountMinor: number) => ({
	id,
	entityId,
	amountMinor,
	currency: "USD",
});

describe("netAllocations", () => {
	it("spreads an order-level refund proportionally, remainder to primary", () => {
		const result = netAllocations({
			allocations: [alloc("a1", "biz", 7000), alloc("a2", "home", 3000)],
			refunds: [
				{
					amountMinor: 1001,
					currency: "USD",
					status: "refunded",
					orderItemId: null,
				},
			],
			primaryEntityId: "biz",
		});
		expect(result.map((r) => r.refundedMinor)).toEqual([701, 300]);
		expect(result.map((r) => r.netMinor)).toEqual([6299, 2700]);
	});

	it("puts item refunds on the item's entity and overflows to the rest", () => {
		const result = netAllocations({
			allocations: [alloc("a1", "biz", 7000), alloc("a2", "home", 3000)],
			items: [{ id: "i2", entityId: "home" }],
			refunds: [
				{
					amountMinor: 3500,
					currency: "USD",
					status: "refunded",
					orderItemId: "i2",
				},
			],
			primaryEntityId: "biz",
		});
		const home = result.find((r) => r.id === "a2");
		const biz = result.find((r) => r.id === "a1");
		expect(home?.netMinor).toBe(0);
		expect(biz?.refundedMinor).toBe(500);
	});

	it("tracks pending refunds separately and ignores other currencies", () => {
		const result = netAllocations({
			allocations: [alloc("a1", "biz", 5000)],
			refunds: [
				{
					amountMinor: 1000,
					currency: "USD",
					status: "requested",
					orderItemId: null,
				},
				{
					amountMinor: 999,
					currency: "EUR",
					status: "refunded",
					orderItemId: null,
				},
			],
			primaryEntityId: "biz",
		});
		expect(result[0]).toMatchObject({
			refundedMinor: 0,
			pendingRefundMinor: 1000,
			netMinor: 5000,
		});
	});

	it("never nets below zero", () => {
		const [row] = netAllocations({
			allocations: [alloc("a1", "biz", 500)],
			refunds: [
				{
					amountMinor: 900,
					currency: "usd",
					status: "refunded",
					orderItemId: null,
				},
			],
			primaryEntityId: "biz",
		});
		expect(row?.netMinor).toBe(0);
		expect(row?.refundedMinor).toBe(500);
	});
});

describe("claimDecision", () => {
	const base = { id: "a", entityId: "e", amountMinor: 1000, currency: "USD" };
	it("blocks fully refunded and cancelled allocations", () => {
		expect(
			claimDecision(
				{ ...base, refundedMinor: 1000, pendingRefundMinor: 0, netMinor: 0 },
				"delivered",
			),
		).toMatchObject({ claimable: false, reason: "fully_refunded" });
		expect(
			claimDecision(
				{ ...base, refundedMinor: 0, pendingRefundMinor: 0, netMinor: 1000 },
				"cancelled",
			),
		).toMatchObject({ claimable: false, reason: "order_cancelled" });
		expect(
			claimDecision(
				{ ...base, refundedMinor: 0, pendingRefundMinor: 1000, netMinor: 1000 },
				"returned",
			),
		).toMatchObject({ claimable: false, reason: "refund_pending" });
	});
	it("claims partially refunded allocations at net", () => {
		expect(
			claimDecision(
				{ ...base, refundedMinor: 300, pendingRefundMinor: 0, netMinor: 700 },
				"delivered",
			),
		).toEqual({ allocationId: "a", claimable: true, claimMinor: 700 });
	});
});

describe("refund parser helpers", () => {
	it("maps store refund text", () => {
		expect(refundStatusFromText("Refund successful")).toBe("refunded");
		expect(refundStatusFromText("Processing")).toBe("approved");
		expect(refundStatusFromText("Awaiting seller")).toBe("requested");
	});
	it("implies a full refund request for cancelled orders only", () => {
		expect(
			impliedRefundFromParsedOrder({
				externalOrderId: "1",
				status: "cancelled",
				totalMinor: 1234,
				currency: "USD",
			}),
		).toMatchObject({
			amountMinor: 1234,
			status: "requested",
			externalRefundId: "cancel:1",
		});
		expect(
			impliedRefundFromParsedOrder({
				externalOrderId: "1",
				status: "delivered",
				totalMinor: 1,
			}),
		).toBeNull();
	});
});

const row = (over: Partial<PurchaseRow>): PurchaseRow => ({
	itemId: Math.random().toString(36),
	orderId: Math.random().toString(36),
	title: "Item",
	sku: null,
	variant: null,
	quantity: 1,
	unitPriceMinor: null,
	totalMinor: null,
	itemUrl: null,
	imageUrl: null,
	source: "amazon",
	merchantName: null,
	orderDate: "2026-01-01",
	currency: "USD",
	externalOrderId: "X",
	...over,
});

describe("items", () => {
	it("normalizes titles and keys by SKU first", () => {
		expect(
			normalizeTitle("【Hot Sale】 PLA Filament 1.75mm, 1KG - Black (2pcs)"),
		).toBe("pla filament 1.75mm 1kg black 2pcs".replace(" 2pcs", ""));
		expect(itemKey({ title: "x", sku: "ab-12 3" })).toBe("sku:AB123");
		expect(itemKey({ title: "USB-C Cable 2m" })).toBe(
			itemKey({ title: "usb c cable, 2m!" }),
		);
	});
	it("groups purchases with price stats, cadence and reorder url", () => {
		const groups = groupPurchases([
			row({
				title: "PLA Filament Black",
				unitPriceMinor: 1999,
				orderDate: "2026-01-01",
				source: "amazon",
			}),
			row({
				title: "pla filament black",
				totalMinor: 3600,
				quantity: 2,
				orderDate: "2026-03-02",
				source: "aliexpress",
				itemUrl: "https://x/y",
			}),
			row({
				title: "PLA filament - black",
				unitPriceMinor: 2100,
				orderDate: "2026-05-01",
			}),
			row({ title: "Other thing", orderDate: "2025-01-01" }),
		]);
		expect(groups).toHaveLength(2);
		const g = groups[0];
		expect(g?.purchases).toBe(3);
		expect(g?.lastPurchaseDate).toBe("2026-05-01");
		expect(g?.minUnitPriceMinor).toBe(1800);
		expect(g?.maxUnitPriceMinor).toBe(2100);
		expect(g?.reorderUrl).toBe("https://x/y");
		expect(g?.cadenceDays).toBe(60);
		expect(g?.stores.sort()).toEqual(["aliexpress", "amazon"]);
		const series = priceSeries(g?.rows ?? [], "USD");
		expect(series.get("amazon")?.map((p) => p.unitPriceMinor)).toEqual([
			1999, 2100,
		]);
	});
	it("derives unit price and escapes LIKE input", () => {
		expect(
			unitPrice({ unitPriceMinor: null, totalMinor: 1000, quantity: 4 }),
		).toBe(250);
		expect(likeEscape("50%_off\\")).toBe("50\\%\\_off\\\\");
		expect(searchTerms("  USB  c cable usb ")).toEqual(["usb", "cable"]);
	});
});

const subject = (over: Partial<DuplicateSubject>): DuplicateSubject => ({
	id: "a",
	source: "aliexpress",
	externalOrderId: "100",
	merchantName: null,
	orderDate: "2026-02-10",
	currency: "USD",
	totalMinor: 4599,
	paymentMethodId: "pm",
	itemTitles: ["Soldering iron T12 station"],
	...over,
});

describe("duplicates", () => {
	it("flags the same purchase captured through a generic channel", () => {
		const c = scorePair(
			subject({}),
			subject({
				id: "b",
				source: "generic",
				externalOrderId: "shop#100",
				orderDate: "2026-02-11",
				itemTitles: ["T12 soldering iron station kit"],
			}),
		);
		expect(c).not.toBeNull();
		expect(c?.score).toBeGreaterThan(0.7);
	});
	it("rejects different totals, far dates, same-store pairs and disjoint items", () => {
		expect(
			scorePair(
				subject({}),
				subject({ id: "b", source: "generic", totalMinor: 5000 }),
			),
		).toBeNull();
		expect(
			scorePair(
				subject({}),
				subject({ id: "b", source: "generic", orderDate: "2026-02-20" }),
			),
		).toBeNull();
		expect(
			scorePair(subject({}), subject({ id: "b", externalOrderId: "101" })),
		).toBeNull();
		expect(
			scorePair(
				subject({}),
				subject({ id: "b", source: "generic", itemTitles: ["Garden hose"] }),
			),
		).toBeNull();
	});
	it("accepts totals within 1% and honours dismissals", () => {
		const b = subject({
			id: "b",
			source: "manual",
			totalMinor: 4630,
			itemTitles: [],
		});
		expect(scorePair(subject({}), b)).not.toBeNull();
		expect(
			detectDuplicates({ subjects: [subject({}), b], dismissed: [["b", "a"]] }),
		).toEqual([]);
		expect(detectDuplicates({ subjects: [subject({}), b] })).toHaveLength(1);
	});
	it("prefers keeping the store-specific order", () => {
		expect(
			suggestKeep(
				subject({ id: "g", source: "generic" }),
				subject({ id: "s" }),
			),
		).toBe("s");
	});
});

describe("tracking", () => {
	it("detects carriers by name and number", () => {
		expect(detectCarrier(null, "1Z999AA10123456784")).toBe("ups");
		expect(detectCarrier("USPS", "x")).toBe("usps");
		expect(detectCarrier(null, "9400111899223856924357")).toBe("usps");
		expect(detectCarrier(null, "YT2412345678901234")).toBe("yunexpress");
		expect(
			detectCarrier("AliExpress Standard Shipping", "LP00123456789012"),
		).toBe("cainiao");
		expect(detectCarrier("Some Post", "ZZ123")).toBe("unknown");
	});
	it("builds links with a 17TRACK fallback", () => {
		expect(trackingLink("FedEx", "123456789012").url).toContain("fedex.com");
		expect(trackingLink(null, "ZZ 1").url).toBe(
			"https://t.17track.net/en#nums=ZZ%201",
		);
	});
	it("normalizes aggregator states", () => {
		expect(normalizeTrackingState("Delivered")).toBe("delivered");
		expect(normalizeTrackingState("InTransit")).toBe("in_transit");
		expect(normalizeTrackingState("OutForDelivery")).toBe("out_for_delivery");
		expect(normalizeTrackingState("DeliveryFailure")).toBe("exception");
		expect(normalizeTrackingState("NotFound")).toBe("unknown");
	});
	it("parses 17TRACK responses and calls the API with the token", async () => {
		const body = {
			code: 0,
			data: {
				accepted: [
					{
						number: "LP1",
						track_info: {
							latest_status: { status: "Delivered" },
							latest_event: {
								time_iso: "2026-03-01T10:00:00+08:00",
								description: "Signed",
							},
						},
					},
				],
				rejected: [{ number: "BAD", error: { code: -1, message: "Invalid" } }],
			},
		};
		expect(parseSeventeenTrackInfo(body)).toEqual([
			{
				number: "LP1",
				state: "delivered",
				statusText: "Delivered",
				lastEventAt: "2026-03-01T10:00:00+08:00",
				lastEventText: "Signed",
				error: null,
			},
			{
				number: "BAD",
				state: "unknown",
				statusText: null,
				lastEventAt: null,
				lastEventText: null,
				error: "Invalid",
			},
		]);
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const provider = seventeenTrackProvider({
			apiKey: "k",
			fetchImpl: async (url, init) => {
				calls.push({ url, init });
				return new Response(JSON.stringify(body), { status: 200 });
			},
		});
		const results = await provider.fetch([
			{ number: "LP1", carrier: "cainiao" },
		]);
		expect(results[0]?.state).toBe("delivered");
		expect(calls[0]?.url).toBe(
			"https://api.17track.net/track/v2.2/gettrackinfo",
		);
		expect((calls[0]?.init.headers as Record<string, string>)["17token"]).toBe(
			"k",
		);
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual([
			{ number: "LP1", carrier: 190271 },
		]);
	});
});

describe("assets", () => {
	it("computes warranty expiry with month-end clamping", () => {
		expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
		expect(addMonths("2025-06-15", 24)).toBe("2027-06-15");
		expect(
			warrantyExpiry({ purchaseDate: "2026-01-10", warrantyMonths: 12 }),
		).toBe("2027-01-10");
		expect(
			warrantyExpiry({ purchaseDate: null, warrantyMonths: 12 }),
		).toBeNull();
		expect(
			warrantyExpiry({
				purchaseDate: "2026-01-10",
				warrantyMonths: 12,
				warrantyExpiresAt: "2028-01-01",
			}),
		).toBe("2028-01-01");
	});
	it("classifies warranty state", () => {
		expect(warrantyState(null, "2026-01-01")).toBe("none");
		expect(warrantyState("2025-12-31", "2026-01-01")).toBe("expired");
		expect(warrantyState("2026-02-01", "2026-01-01")).toBe("expiring");
		expect(warrantyState("2026-12-01", "2026-01-01")).toBe("active");
	});
	it("exports CSV safely", () => {
		const csv = assetsToCsv([
			{
				name: '=cmd, "x"',
				serial: "SN1",
				status: "in_service",
				entityName: null,
				purchaseDate: "2026-01-01",
				warrantyMonths: 12,
				warrantyExpiresAt: "2027-01-01",
				location: null,
				source: "Amazon",
				externalOrderId: "1",
				unitPriceMinor: 12345,
				currency: "USD",
				notes: null,
			},
		]);
		const [, line] = csv.split("\r\n");
		expect(line).toBe(
			`"'=cmd, ""x""",SN1,in_service,,2026-01-01,12,2027-01-01,,Amazon,1,123.45,USD,`,
		);
	});
});
