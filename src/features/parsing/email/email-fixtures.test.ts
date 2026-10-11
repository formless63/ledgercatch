/**
 * Table-driven email parser tests over realistic .eml fixtures.
 *
 * Layout: fixtures/email/<store>-<name>.eml next to <same>.expect.json
 * (not `.case.json`: fixtures.test.ts treats every fixtures/<dir> as a
 * store id and would reject "email").
 *
 *   {
 *     "description": "…",
 *     "mime":   { "source", "from"?, "subject"?, "forwarded"?, "attachments"?, "dateStartsWith"? },
 *     "expect": { "outcome", "parserId"?, "orderCount"?, "orders"?: [partial ParsedOrder…] }
 *   }
 *
 * The whole path runs: raw MIME → mailparser + forward unwrapping + store
 * detection (mime.server) → deterministic email chain (no AI).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMimeMessage } from "#/features/ingress/email/mime.server";
import type { ParsedOrder, ParseResult } from "../types";
import { emailKind, stripSubjectPrefixes } from "./common";
import { detectStoreFromSender } from "./detect";
import { registrableDomain, subjectOrderId } from "./generic";
import { parseEmailMessage } from "./index";

const DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
	"email",
);

type Expect = {
	description?: string;
	mime: {
		source: string;
		from?: string;
		subject?: string;
		forwarded?: "inline" | "attachment" | null;
		attachments?: string[];
		dateStartsWith?: string;
	};
	expect: {
		outcome: ParseResult["outcome"];
		parserId?: string;
		orderCount?: number;
		orders?: Array<Partial<ParsedOrder> & { externalOrderId: string }>;
	};
};

const cases = readdirSync(DIR)
	.filter((f) => f.endsWith(".eml"))
	.sort();

describe("email fixtures", () => {
	it("every .eml has an .expect.json", () => {
		for (const file of cases)
			expect(
				readdirSync(DIR),
				`${file} needs ${file.replace(/\.eml$/, ".expect.json")}`,
			).toContain(file.replace(/\.eml$/, ".expect.json"));
	});

	for (const file of cases) {
		const specPath = join(DIR, file.replace(/\.eml$/, ".expect.json"));
		let spec: Expect | undefined;
		try {
			spec = JSON.parse(readFileSync(specPath, "utf8")) as Expect;
		} catch {
			spec = undefined;
		}
		if (!spec) continue;
		const s = spec;
		it(`${file}${s.description ? ` — ${s.description}` : ""}`, async () => {
			const raw = new Uint8Array(readFileSync(join(DIR, file)));
			const mime = await parseMimeMessage(raw);
			expect(mime.source).toBe(s.mime.source);
			if (s.mime.from) expect(mime.from?.address).toBe(s.mime.from);
			if (s.mime.subject) expect(mime.subject).toBe(s.mime.subject);
			if (s.mime.forwarded !== undefined)
				expect(mime.forwarded?.via ?? null).toBe(s.mime.forwarded);
			if (s.mime.attachments)
				expect(mime.attachments.map((a) => a.fileName)).toEqual(
					s.mime.attachments,
				);
			if (s.mime.dateStartsWith)
				expect(mime.date?.startsWith(s.mime.dateStartsWith)).toBe(true);

			const email = {
				source: mime.source,
				messageId: mime.messageId,
				from: mime.from,
				subject: mime.subject,
				date: mime.date,
				html: mime.html,
				text: mime.text,
				attachments: mime.attachments.map((a) => ({
					fileName: a.fileName,
					contentType: a.contentType,
				})),
			};
			const outcome = parseEmailMessage(email);
			// Deterministic.
			expect(parseEmailMessage(email)).toEqual(outcome);
			const { result } = outcome;
			expect(result.outcome, JSON.stringify(result, null, 2)).toBe(
				s.expect.outcome,
			);
			if (s.expect.parserId) expect(outcome.parserId).toBe(s.expect.parserId);
			if (result.outcome !== "orders") return;
			if (s.expect.orderCount !== undefined)
				expect(result.orders).toHaveLength(s.expect.orderCount);
			for (const order of result.orders) {
				if (order.orderDate)
					expect(order.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				for (const [key, value] of Object.entries(order))
					expect(value, `${key} omitted, not undefined`).not.toBeUndefined();
			}
			for (const expected of s.expect.orders ?? []) {
				const actual = result.orders.find(
					(o) => o.externalOrderId === expected.externalOrderId,
				);
				expect(actual, expected.externalOrderId).toBeDefined();
				expect(actual).toMatchObject(expected);
			}
		});
	}
});

describe("email helpers", () => {
	it("detects stores from sender, subject and body", () => {
		expect(detectStoreFromSender("auto-confirm@amazon.co.uk", "", "")).toBe(
			"amazon",
		);
		expect(
			detectStoreFromSender("bounce@amazonses.com", "Your receipt", ""),
		).toBe("generic");
		expect(
			detectStoreFromSender("transaction@notice.aliexpress.com", "", ""),
		).toBe("aliexpress");
		expect(detectStoreFromSender("x@service.alibaba.com", "", "")).toBe(
			"alibaba",
		);
		expect(detectStoreFromSender("ebay@ebay.de", "", "")).toBe("ebay");
		expect(
			detectStoreFromSender(
				"me@example.com",
				"Fwd: Mouser Electronics Order Acknowledgement",
				"",
			),
		).toBe("mouser");
		expect(
			detectStoreFromSender(
				"me@example.com",
				"see below",
				'<a href="https://www.digikey.com/OrderHistory/ReviewOrder/1">x</a>',
			),
		).toBe("digikey");
	});

	it("classifies email kinds", () => {
		expect(emailKind('Delivered: "Thing"', "")).toBe("delivered");
		expect(emailKind("Your order is on its way", "")).toBe("shipped");
		expect(emailKind("Order Confirmation – Sales Order #1", "")).toBe(
			"confirmation",
		);
		expect(emailKind("Your order has been cancelled", "")).toBe("cancelled");
		expect(emailKind("Fall sale", "nothing")).toBe("other");
	});

	it("parses subjects and domains", () => {
		expect(stripSubjectPrefixes("Fwd: RE: FW: Your order")).toBe("Your order");
		expect(subjectOrderId("[Maker Shop]: New order #42")).toBe("42");
		expect(subjectOrderId("Order #1001 confirmed")).toBe("1001");
		expect(subjectOrderId("Fall sale: 20% off")).toBeUndefined();
		expect(registrableDomain("mail.shop.co.uk")).toBe("shop.co.uk");
		expect(registrableDomain("orders.acme.com")).toBe("acme.com");
	});
});
