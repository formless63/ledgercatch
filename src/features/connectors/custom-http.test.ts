import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	customHttpConfigSchema,
	exampleDefinition,
	inspectOpenApi,
	parseDefinition,
	previewExpense,
} from "./custom-http";
import { approvedAddress, customHttpProvider } from "./custom-http.server";
import type { ExpensePayload } from "./types";

let server: Server;
let origin: string;
let calls: string[] = [];
const records = new Map<string, string>();
let expenseWrites = 0;
let attachments = 0;
const saved = process.env.CUSTOM_HTTP_ENDPOINTS;
beforeAll(async () => {
	server = createServer(async (req, res) => {
		calls.push(`${req.method} ${req.url}`);
		if (req.headers.authorization !== "Bearer test-token") {
			res.writeHead(401);
			res.end("test-token MUST NOT LEAK");
			return;
		}
		if (req.url === "/redirect") {
			res.writeHead(307, { Location: "http://127.0.0.1:1/private" });
			res.end();
			return;
		}
		if (req.url === "/large") {
			res.end("x".repeat(1024 * 1024 + 1));
			return;
		}
		if (req.url === "/health") {
			res.end("{}");
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString());
		if (req.url === "/expenses") {
			const key = String(req.headers["idempotency-key"]);
			const existing = records.get(key);
			if (existing && existing !== JSON.stringify(body)) {
				res.writeHead(409);
				res.end("{}");
				return;
			}
			if (!existing) expenseWrites++;
			records.set(key, JSON.stringify(body));
			res.end(JSON.stringify({ id: "expense-1" }));
			return;
		}
		attachments++;
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("listen");
	origin = `http://127.0.0.1:${address.port}`;
	process.env.CUSTOM_HTTP_ENDPOINTS = JSON.stringify([
		{ origin, addresses: ["127.0.0.1"] },
	]);
});
afterAll(async () => {
	if (saved === undefined) delete process.env.CUSTOM_HTTP_ENDPOINTS;
	else process.env.CUSTOM_HTTP_ENDPOINTS = saved;
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
function context(definition = exampleDefinition) {
	return {
		config: customHttpConfigSchema.parse({
			baseUrl: origin,
			auth: "bearer",
			definition: JSON.stringify(definition),
		}),
		secret: { token: "test-token" },
	};
}
const payload: ExpensePayload = {
	reference: "synthetic-stable-1",
	orderRef: "sample-1",
	date: "2026-09-01",
	vendorName: "Example",
	amount: "42.50",
	currency: "EUR",
	memo: "Synthetic",
	reimbursable: true,
	lineSummary: [],
	documents: [],
};
describe("custom HTTP", () => {
	it("requires operator approval and pins literal addresses", () => {
		expect(() => approvedAddress("https://unknown.example")).toThrow(
			/approved/,
		);
		expect(approvedAddress(origin)).toBe("127.0.0.1");
	});
	it("tests only the configured GET and redacts remote errors", async () => {
		calls = [];
		expect((await customHttpProvider.test(context())).ok).toBe(true);
		expect(calls).toEqual(["GET /health"]);
		const res = await customHttpProvider.test({
			...context(),
			secret: { token: "wrong" },
		});
		expect(res).toEqual({
			ok: false,
			error: "Custom HTTP returned HTTP 401; no remote body retained",
		});
	});
	it("does not follow redirects or accept unbounded responses", async () => {
		for (const path of ["/redirect", "/large"]) {
			const d = {
				...exampleDefinition,
				test: { method: "GET" as const, path },
			};
			const r = await customHttpProvider.test(context(d));
			expect(r.ok).toBe(false);
		}
		expect(calls).not.toContain("GET /private");
	});
	it("preserves exact currency, mappings and stable idempotency across retry", async () => {
		const first = await customHttpProvider.pushExpense(context(), payload);
		const repeat = await customHttpProvider.pushExpense(context(), payload);
		expect(first).toMatchObject({ status: "created", remoteId: "expense-1" });
		expect(repeat).toEqual(first);
		expect(expenseWrites).toBe(1);
		expect(JSON.parse(records.get(payload.reference) ?? "{}")).toMatchObject({
			amount: "42.50",
			currency: "EUR",
			reference: payload.reference,
		});
		await expect(
			customHttpProvider.pushExpense(context(), {
				...payload,
				amount: "43.00",
			}),
		).rejects.toMatchObject({ status: 409, retryable: false });
	});
	it("attaches only within explicit limits and keeps expense success on receipt failure", async () => {
		const d = {
			...exampleDefinition,
			attachment: {
				method: "POST" as const,
				path: "/expenses/{id}/receipts",
				fileField: "data",
				maxBytes: 10,
				idempotencyHeader: "Idempotency-Key",
				idempotencyConfirmed: true as const,
			},
		};
		const r = await customHttpProvider.pushExpense(context(d), {
			...payload,
			reference: "with-receipt",
			documents: [
				{
					fileName: "demo.txt",
					contentType: "text/plain",
					sizeBytes: 4,
					sha256: "ignored",
					load: async () => new TextEncoder().encode("demo"),
				},
			],
		});
		expect(r.warnings).toEqual([]);
		expect(attachments).toBe(1);
		const tooLarge = await customHttpProvider.attachDocument?.(
			context(d),
			"expense-1",
			{
				fileName: "x",
				contentType: "text/plain",
				bytes: new Uint8Array(11),
				sha256: "x",
			},
		);
		expect(tooLarge?.status).toBe("skipped");
	});
	it("rejects authentication headers that overwrite idempotency keys", () => {
		expect(
			customHttpConfigSchema.safeParse({
				baseUrl: origin,
				auth: "api_key",
				authHeader: "IDEMPOTENCY-KEY",
				definition: JSON.stringify(exampleDefinition),
			}).success,
		).toBe(false);
	});
	it("dry runs are pure and mappings are typed", () => {
		const before = calls.length;
		expect(previewExpense(exampleDefinition, payload)).toMatchObject({
			amount: "42.50",
		});
		expect(calls).toHaveLength(before);
		expect(() =>
			parseDefinition(
				JSON.stringify({
					...exampleDefinition,
					expense: {
						...exampleDefinition.expense,
						idempotencyConfirmed: false,
					},
				}),
			),
		).toThrow();
	});
	it("bounds OpenAPI complexity and never resolves references", () => {
		expect(
			inspectOpenApi(
				JSON.stringify({
					openapi: "3.1.0",
					paths: {
						"/expenses": {
							post: {
								summary: "Create",
								requestBody: {
									content: {
										"application/json": { schema: { type: "object" } },
									},
								},
							},
						},
					},
				}),
			),
		).toEqual([
			{
				method: "POST",
				path: "/expenses",
				summary: "Create",
				requestSchema: { type: "object" },
			},
		]);
		for (const doc of [
			{ openapi: "3.1.0", paths: {}, $ref: "https://evil.test" },
			{ openapi: "3.1.0", paths: {}, callbacks: {} },
		])
			expect(() => inspectOpenApi(JSON.stringify(doc))).toThrow();
		expect(() => inspectOpenApi(" ".repeat(262145))).toThrow(/256/);
	});
});
