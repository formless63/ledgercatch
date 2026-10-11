/**
 * Table-driven parser tests over real-shaped fixtures.
 *
 * Layout: fixtures/<store>/<name>.case.json next to its payload file.
 *
 *   {
 *     "description": "…",
 *     "input":   { "kind", "pageType", "pageUrl", "pageTitle"?, "orderIdHints"? },
 *     "payload": { "file": "page.html" }                       // HTML snapshot
 *              | { "file": "body.json", "requestUrl": "…" }    // intercepted JSON
 *              | { "file": "page.txt" },                       // page_text
 *     "expect":  { "outcome", "orderCount"?, "orders"?: [partial ParsedOrder…], "warnings"?: [...] }
 *   }
 *
 * Recorder captures: instead of `input` + `payload`, set `"capture":
 * "x.capture.json"` pointing at a full CaptureEnvelope exported by the
 * extension's recorder mode; the store comes from the envelope's `source`.
 *
 * `orders` entries are matched by externalOrderId with toMatchObject, so only
 * list the fields you care about (arrays such as `items` must match in length).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	captureEnvelopeSchema,
	type StoreId,
	storeIdSchema,
} from "#/shared/capture";
import { getParser } from "./registry";
import type { ParsedOrder, ParseResult, ParserInput } from "./types";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type CaseFile = {
	description?: string;
	capture?: string;
	input?: Partial<Omit<ParserInput, "payload" | "source">>;
	payload?: { file: string; requestUrl?: string };
	expect: {
		outcome: ParseResult["outcome"];
		orderCount?: number;
		orders?: Array<Partial<ParsedOrder> & { externalOrderId: string }>;
		warnings?: string[];
	};
};

function loadCase(
	store: string,
	file: string,
): { input: ParserInput; spec: CaseFile } {
	const dir = join(FIXTURES, store);
	const spec = JSON.parse(readFileSync(join(dir, file), "utf8")) as CaseFile;
	if (spec.capture) {
		const envelope = captureEnvelopeSchema.parse(
			JSON.parse(readFileSync(join(dir, spec.capture), "utf8")),
		);
		return {
			spec,
			input: {
				source: envelope.source,
				kind: envelope.kind,
				pageType: envelope.pageType,
				pageUrl: envelope.pageUrl,
				pageTitle: envelope.pageTitle,
				capturedAt: envelope.capturedAt,
				orderIdHints: envelope.orderIdHints,
				payload: envelope.payload,
			},
		};
	}
	if (!spec.payload) throw new Error(`${file}: needs "payload" or "capture"`);
	const raw = readFileSync(join(dir, spec.payload.file), "utf8");
	const ext = spec.payload.file.split(".").pop();
	const payload: ParserInput["payload"] =
		ext === "json"
			? {
					type: "json",
					requestUrl: spec.payload.requestUrl ?? "https://example.invalid/",
					body: JSON.parse(raw),
				}
			: ext === "txt"
				? { type: "text", text: raw }
				: { type: "html", html: raw };
	return {
		spec,
		input: {
			source: storeIdSchema.parse(store),
			kind:
				spec.input?.kind ??
				(payload.type === "json"
					? "api_json"
					: payload.type === "text"
						? "page_text"
						: "html_snapshot"),
			pageType: spec.input?.pageType ?? "unknown",
			pageUrl: spec.input?.pageUrl ?? "https://example.invalid/",
			pageTitle: spec.input?.pageTitle ?? "",
			capturedAt: spec.input?.capturedAt ?? "2026-10-08T12:00:00.000Z",
			orderIdHints: spec.input?.orderIdHints ?? [],
			payload,
		},
	};
}

function assertInvariants(result: ParseResult) {
	if (result.outcome !== "orders") return;
	for (const order of result.orders) {
		expect(order.externalOrderId).toMatch(/\S/);
		if (order.orderDate) expect(order.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		if (order.currency) expect(order.currency).toMatch(/^[A-Z]{3}$/);
		for (const key of [
			"subtotalMinor",
			"shippingMinor",
			"taxMinor",
			"discountMinor",
			"totalMinor",
		] as const) {
			const value = order[key];
			if (value !== undefined)
				expect(Number.isInteger(value), `${key} integer`).toBe(true);
		}
		for (const item of order.items ?? []) {
			expect(item.title.trim()).not.toBe("");
			expect(item.quantity).toBeGreaterThan(0);
			if (item.unitPriceMinor !== undefined)
				expect(Number.isInteger(item.unitPriceMinor)).toBe(true);
		}
		for (const [key, value] of Object.entries(order))
			expect(
				value,
				`${key} should be omitted, not undefined`,
			).not.toBeUndefined();
	}
}

const stores = readdirSync(FIXTURES, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);

for (const store of stores) {
	const cases = readdirSync(join(FIXTURES, store)).filter((f) =>
		f.endsWith(".case.json"),
	);
	if (cases.length === 0) continue;
	describe(`${store} fixtures`, () => {
		for (const file of cases) {
			const { input, spec } = loadCase(store, file);
			it(`${file}${spec.description ? ` — ${spec.description}` : ""}`, () => {
				const parser = getParser(input.source as StoreId);
				expect(parser, `parser for ${input.source}`).toBeDefined();
				if (!parser) return;
				const result = parser.parse(input);
				// Deterministic: same input → identical output.
				expect(parser.parse(input)).toEqual(result);
				assertInvariants(result);
				expect(
					result.outcome,
					JSON.stringify(result, null, 2).slice(0, 4000),
				).toBe(spec.expect.outcome);
				if (result.outcome !== "orders") return;
				if (spec.expect.orderCount !== undefined)
					expect(result.orders).toHaveLength(spec.expect.orderCount);
				for (const expected of spec.expect.orders ?? []) {
					const actual = result.orders.find(
						(o) => o.externalOrderId === expected.externalOrderId,
					);
					expect(
						actual,
						`order ${expected.externalOrderId} in ${JSON.stringify(result.orders.map((o) => o.externalOrderId))}`,
					).toBeDefined();
					expect(actual).toMatchObject(expected);
				}
				for (const warning of spec.expect.warnings ?? [])
					expect(result.warnings).toContain(warning);
			});
		}
	});
}
