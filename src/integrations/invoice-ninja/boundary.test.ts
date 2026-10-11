import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { InvoiceNinjaError } from "./errors";
import { outputDecimal, parseExactJson } from "./json";
import { invoiceProjection } from "./projection";
import {
	providerRequest,
	readBounded,
	validateConnection,
} from "./transport.server";
import { decodeCursor, draftInput, encodeCursor, parse } from "./validation";
import { authenticateHint } from "./webhook.server";

const id = "1c2ec89c-8de9-449f-bb3e-e04a544c7d4e";
const draft = {
	clientBindingId: id,
	idempotencyKey: "abc",
	invoiceDate: "2026-10-02",
	numbering: { mode: "provider" },
	lines: [
		{
			description: "Service",
			quantity: "99999999999999.1234",
			unitCost: "0.0100",
		},
	],
};
describe("Invoice Ninja boundaries (local protocol fixtures, not provider compatibility)", () => {
	test("closed input, exact decimals and real dates", () => {
		expect(parse(draftInput, draft).lines[0]?.unitCost).toBe("0.01");
		for (const bad of [
			{ ...draft, send: true },
			{ ...draft, invoiceDate: "2026-02-30" },
			{ ...draft, dueDate: "2026-10-01" },
			{
				...draft,
				lines: [{ description: "x", quantity: "0.0000", unitCost: "1" }],
			},
			{
				...draft,
				lines: [{ description: "x", quantity: "1", unitCost: "-1" }],
			},
		])
			expect(() => parse(draftInput, bad)).toThrow(InvoiceNinjaError);
	});
	test("native invoice currency comes from trusted client policy, not a nonexistent field", () => {
		const native = {
			id: "invoice-native",
			number: "DRAFT-1",
			status_id: "1",
			amount: "25",
			balance: "0",
			updated_at: "1790907000",
		};
		expect(invoiceProjection(native, () => "USD")).toMatchObject({
			currency: "USD",
			amount: "25",
			balance: "0",
			status: "draft",
		});
		expect(invoiceProjection(native, () => null).currency).toBeNull();
	});
	test("canonical cursor", () => {
		const cursor = encodeCursor(new Date("2026-10-02T00:00:00.000Z"), id);
		expect(decodeCursor(cursor)).toEqual(["2026-10-02T00:00:00.000Z", id]);
		for (const bad of [
			`${cursor}=`,
			Buffer.from(JSON.stringify([1, "2026-02-30T00:00:00.000Z", id])).toString(
				"base64url",
			),
			Buffer.from("[1]").toString("base64url"),
			Buffer.from([255]).toString("base64url"),
		])
			expect(() => decodeCursor(bad)).toThrow();
	});
	test("numeric lexemes remain exact and duplicates fail closed", () => {
		const data = parseExactJson(
			new TextEncoder().encode(
				'{"amount":999999999999999999999999.12345678,"balance":-1.2000}',
			),
		) as Record<string, unknown>;
		expect(outputDecimal(data.amount)).toBe(
			"999999999999999999999999.12345678",
		);
		expect(outputDecimal(data.balance)).toBe("-1.2");
		expect(() => outputDecimal(1.2)).toThrow();
		expect(() =>
			parseExactJson(new TextEncoder().encode('{"id":"a","id":"b"}')),
		).toThrow();
	});
	test("HTTPS and original literal loopback only", () => {
		for (const url of [
			"http://localhost:3000",
			"http://2130706433",
			"http://127.1",
			"http://0x7f000001",
			"https://user:pass@example.com",
			"https://example.com/#fragment",
			"https://example.com/#",
			"https://@example.com",
		])
			expect(() =>
				validateConnection({ baseUrl: url, apiToken: "token" }, "test"),
			).toThrow();
		expect(
			validateConnection(
				{ baseUrl: "http://127.0.0.1:3000", apiToken: "token" },
				"test",
			).baseUrl,
		).toBe("http://127.0.0.1:3000");
		expect(() =>
			validateConnection(
				{ baseUrl: "http://127.0.0.1:3000", apiToken: "token" },
				"production",
			),
		).toThrow();
	});
	test("overflow closes a streaming body", async () => {
		let closed = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				c.enqueue(new Uint8Array(8));
			},
			cancel() {
				closed = true;
			},
		});
		await expect(
			readBounded(stream, 4, new AbortController().signal),
		).rejects.toMatchObject({ code: "limit_exceeded" });
		expect(closed).toBe(true);
	});
	test("rotation, authenticated root entity and hash identity without body retention", async () => {
		const current = "a".repeat(32),
			previous = "b".repeat(32);
		const body = JSON.stringify({
			id: "remote",
			contacts: [{ email: "private@example.test" }],
		});
		const request = (key: string) =>
			new Request("https://example.test", {
				method: "POST",
				headers: { "X-Invoice-Ninja-Webhook-Secret": key },
				body,
			});
		const first = await authenticateHint(request(current), current, previous);
		expect(
			await authenticateHint(request(previous), current, previous),
		).toEqual(first);
		expect(Object.keys(first).sort()).toEqual(["bodySHA256", "remoteId"]);
		await expect(
			authenticateHint(request("bad"), current),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			authenticateHint(request(`${current}, ${current}`), current),
		).rejects.toMatchObject({ code: "invalid_input" });
	});
	test("real wire GET, headers, body cancellation, timeout and no retry", async () => {
		let attempts = 0;
		let closed = 0;
		const server = createServer((req, res) => {
			attempts++;
			expect(req.headers["x-api-token"]).toBe("test-token");
			expect(req.headers["x-requested-with"]).toBe("XMLHttpRequest");
			expect(req.headers["x-api-secret"]).toBeUndefined();
			req.on("close", () => {
				closed++;
			});
			if (req.url?.endsWith("/slow-headers")) {
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.write('{"id":"remote"');
			if (req.url?.endsWith("/slow-body")) return;
			res.end("}");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const connection = {
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			apiToken: "test-token",
		};
		try {
			const result = await providerRequest(connection, "invoice", "remote", {
				environment: "test",
			});
			expect(result.status).toBe(200);
			await expect(
				providerRequest(connection, "invoice", "slow-headers", {
					environment: "test",
					timeoutMs: 50,
				}),
			).rejects.toMatchObject({ code: "deadline_exceeded" });
			await expect(
				providerRequest(connection, "invoice", "slow-body", {
					environment: "test",
					timeoutMs: 50,
				}),
			).rejects.toMatchObject({ code: "deadline_exceeded" });
			const abort = new AbortController();
			const call = providerRequest(connection, "client", "slow-body", {
				environment: "test",
				signal: abort.signal,
			});
			setTimeout(() => abort.abort(), 50);
			await expect(call).rejects.toMatchObject({ code: "cancelled" });
			expect(attempts).toBe(4);
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(closed).toBeGreaterThan(0);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
