import { describe, expect, it } from "vitest";
import { alibabaParser } from "#/features/parsing/alibaba";
import { computeAllocations } from "./allocation";
import { shouldReplaceItems } from "./merge";
import { evaluateRules, type RuleLike } from "./rules";

const baseOrder = {
	currency: "USD",
	entityId: "biz",
	totalMinor: 10_000,
	subtotalMinor: 9_000,
	shippingMinor: 500,
	taxMinor: 500,
	discountMinor: null,
	categoryId: null,
	reimbursableOverride: null,
};

describe("computeAllocations", () => {
	it("returns nothing for unassigned orders", () => {
		expect(
			computeAllocations({
				order: { ...baseOrder, entityId: null },
				items: [{ totalMinor: 9000, entityId: null, categoryId: null }],
				payingEntityId: null,
				existing: [],
			}),
		).toEqual([]);
	});

	it("assigns the whole total to the primary entity and flags reimbursement", () => {
		const [only, ...rest] = computeAllocations({
			order: baseOrder,
			items: [{ totalMinor: 9000, entityId: null, categoryId: null }],
			payingEntityId: "personal",
			existing: [],
		});
		expect(rest).toHaveLength(0);
		expect(only).toMatchObject({
			entityId: "biz",
			amountMinor: 10_000,
			reimbursable: true,
			reimbursementStatus: "pending",
		});
	});

	it("splits proportionally with remainder to primary and keeps statuses", () => {
		const rows = computeAllocations({
			order: baseOrder,
			items: [
				{ totalMinor: 6000, entityId: null, categoryId: null },
				{ totalMinor: 3000, entityId: "personal", categoryId: "cat" },
			],
			payingEntityId: "personal",
			existing: [{ entityId: "biz", reimbursementStatus: "submitted" }],
		});
		const biz = rows.find((r) => r.entityId === "biz");
		const personal = rows.find((r) => r.entityId === "personal");
		expect(personal).toMatchObject({
			amountMinor: 3333,
			reimbursable: false,
			reimbursementStatus: "none",
			categoryId: "cat",
		});
		expect(biz).toMatchObject({
			amountMinor: 6667,
			reimbursementStatus: "submitted",
		});
	});

	it("respects a forced non-reimbursable override", () => {
		const [row] = computeAllocations({
			order: { ...baseOrder, reimbursableOverride: false },
			items: [],
			payingEntityId: "personal",
			existing: [],
		});
		expect(row?.reimbursable).toBe(false);
	});
});

describe("evaluateRules", () => {
	const subject = {
		source: "digikey",
		merchant: "DigiKey",
		itemTitles: ["STM32F411 dev board"],
		skus: ["497-14711-ND"],
		paymentLast4: "4012",
		totalMinor: 12_345,
		currency: "USD",
	};
	const rule = (overrides: Partial<RuleLike>): RuleLike => ({
		id: "r",
		name: "r",
		enabled: true,
		priority: 100,
		match: "all",
		conditions: [],
		actions: {},
		...overrides,
	});

	it("applies first matching rule per field by priority", () => {
		const outcome = evaluateRules(
			[
				rule({
					id: "late",
					priority: 200,
					conditions: [{ field: "source", op: "equals", value: "digikey" }],
					actions: { entityId: "other", categoryId: "parts" },
				}),
				rule({
					id: "early",
					priority: 10,
					conditions: [
						{ field: "item_title", op: "contains", value: "stm32" },
						{ field: "payment_last4", op: "equals", value: "4012" },
					],
					actions: { entityId: "biz", reimbursable: "yes" },
				}),
			],
			subject,
		);
		expect(outcome.actions).toEqual({
			entityId: "biz",
			reimbursable: "yes",
			categoryId: "parts",
		});
		expect(outcome.matchedRuleIds).toEqual(["early", "late"]);
	});

	it("handles amount thresholds, regex and disabled rules", () => {
		const outcome = evaluateRules(
			[
				rule({
					id: "disabled",
					enabled: false,
					conditions: [{ field: "total", op: "gt", value: "1" }],
					actions: { file: true },
				}),
				rule({
					id: "big",
					match: "any",
					conditions: [
						{ field: "total", op: "gt", value: "100" },
						{ field: "sku", op: "matches", value: "^nope" },
					],
					actions: { tags: ["big"] },
				}),
				rule({
					id: "bad-regex",
					conditions: [{ field: "merchant", op: "matches", value: "(" }],
					actions: { file: true },
				}),
			],
			subject,
		);
		expect(outcome.actions).toEqual({ tags: ["big"] });
	});
});

describe("placed-by group merge and matching", () => {
	it("matches case-insensitively without matching missing groups", () => {
		const rule: RuleLike = {
			id: "group",
			name: "group",
			enabled: true,
			priority: 1,
			match: "all",
			conditions: [
				{ field: "placed_by_group", op: "equals", value: "Example LLC" },
			],
			actions: { entityId: "biz" },
		};
		const subject = {
			source: "amazon",
			merchant: null,
			itemTitles: [],
			skus: [],
			paymentLast4: null,
			totalMinor: null,
			currency: null,
		};
		expect(
			evaluateRules([rule], { ...subject, placedByGroup: "example llc" })
				.actions.entityId,
		).toBe("biz");
		expect(evaluateRules([rule], subject).matchedRuleIds).toEqual([]);
	});
});

it("Alibaba history previews cannot erase already stored detail prices", () => {
	const result = alibabaParser.parse({
		source: "alibaba",
		kind: "html_snapshot",
		pageType: "order_list",
		pageUrl: "https://biz.alibaba.com/order/list.htm",
		pageTitle: "",
		capturedAt: "2026-10-10T12:00:00Z",
		orderIdHints: [],
		payload: {
			type: "html",
			html: '<div class="order-list-item"><span class="order-id">Order #200000000000000001</span><div class="product-item"><p class="product-desc">Example part</p><p>x 10 items</p></div></div>',
		},
	});
	if (result.outcome !== "orders") throw new Error("Expected order list");
	const order = result.orders[0];
	if (!order) throw new Error("Expected order");
	expect(shouldReplaceItems(order, 1)).toBe(false);
	expect(shouldReplaceItems(order, 0)).toBe(true);
});
