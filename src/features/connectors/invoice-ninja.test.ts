import { describe, expect, it } from "vitest";
import {
	type InvoiceNinjaConfig,
	invoiceNinjaProvider,
} from "./invoice-ninja.server";
import { json, mockFetch, type RecordedCall } from "./test-helpers";
import type { ExpensePayload } from "./types";

const config: InvoiceNinjaConfig = {
	baseUrl: "https://in.example",
	categoryAccountMap: {},
	paymentAccountMap: {},
};
const secret = { apiToken: "in-token-123456" };

const statics = {
	currencies: [
		{ id: "1", code: "USD", name: "US Dollar" },
		{ id: "3", code: "EUR", name: "Euro" },
	],
	payment_types: [{ id: "5", name: "Credit Card Other" }],
};

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function payload(over: Partial<ExpensePayload> = {}): ExpensePayload {
	return {
		reference: "OT-1a2b3c4d",
		orderRef: "amazon 113-1234567-1234567",
		date: "2026-09-30",
		vendorName: "Amazon",
		amount: "42.50",
		currency: "EUR",
		memo: "USB cables",
		expenseAccountId: "cat-hash",
		paymentAccountId: "5",
		reimbursable: false,
		lineSummary: ["2 × USB cable"],
		documents: [
			{
				fileName: "invoice.pdf",
				contentType: "application/pdf",
				sizeBytes: pdf.byteLength,
				sha256: "a".repeat(64),
				load: async () => pdf,
			},
		],
		...over,
	};
}

function route(handlers: Record<string, (c: RecordedCall) => Response>) {
	return mockFetch((c) => {
		const u = new URL(c.url);
		const key = `${c.method} ${u.pathname}`;
		const h = handlers[key];
		if (!h) throw new Error(`unexpected ${key}`);
		return h(c);
	});
}

describe("invoice ninja", () => {
	it("pushes: dedupe search, currency, vendor create, expense, multipart upload", async () => {
		const { fetch, calls } = route({
			"GET /api/v1/expenses": () =>
				json({
					data: [{ id: "x1", public_notes: "something [OT-1a2b3c4] else" }],
					meta: { pagination: { total_pages: 1 } },
				}),
			"GET /api/v1/statics": () => json(statics),
			"GET /api/v1/vendors": () =>
				json({ data: [{ id: "vx", name: "Amazon Business" }] }),
			"POST /api/v1/vendors": () =>
				json({ data: { id: "VND1", name: "Amazon" } }),
			"POST /api/v1/expenses": () =>
				json({ data: { id: "EXP1", number: "0001" } }),
			"POST /api/v1/expenses/EXP1/upload": () => json({ data: { id: "EXP1" } }),
		});

		const res = await invoiceNinjaProvider.pushExpense(
			{ config, secret, fetch },
			payload(),
		);
		expect(res).toEqual({
			status: "created",
			remoteId: "EXP1",
			remoteUrl: "https://in.example/#/expenses/EXP1/edit",
			warnings: [],
		});

		const search = new URL((calls[0] as RecordedCall).url);
		expect(search.searchParams.get("filter")).toBe("OT-1a2b3c4d");
		for (const c of calls) {
			expect(c.headers["x-api-token"]).toBe("in-token-123456");
			expect(c.headers["x-requested-with"]).toBe("XMLHttpRequest");
		}

		const vendorPost = calls.find(
			(c) => c.method === "POST" && c.url.endsWith("/vendors"),
		);
		expect(JSON.parse(String(vendorPost?.body))).toEqual({ name: "Amazon" });

		const expensePost = calls.find(
			(c) => c.method === "POST" && c.url.endsWith("/api/v1/expenses"),
		);
		expect(expensePost?.headers["content-type"]).toBe("application/json");
		expect(JSON.parse(String(expensePost?.body))).toEqual({
			vendor_id: "VND1",
			amount: 42.5,
			date: "2026-09-30",
			currency_id: "3",
			category_id: "cat-hash",
			payment_type_id: "5",
			payment_date: "2026-09-30",
			public_notes: "USB cables · amazon 113-1234567-1234567 · [OT-1a2b3c4d]",
			private_notes:
				"Exported by ledgercatch [OT-1a2b3c4d]\nOrder: amazon 113-1234567-1234567\n- 2 × USB cable",
			transaction_reference: "amazon 113-1234567-1234567",
			should_be_invoiced: false,
		});

		const upload = calls.find((c) => c.url.endsWith("/upload")) as RecordedCall;
		expect(upload.method).toBe("POST");
		expect(upload.headers["content-type"]).toBeUndefined();
		const form = upload.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(form.get("_method")).toBe("PUT");
		const file = form.getAll("documents[]")[0] as File;
		expect(file.name).toBe("invoice.pdf");
		expect(file.type).toBe("application/pdf");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);
	});

	it("returns duplicate when our reference is already present", async () => {
		const { fetch, calls } = route({
			"GET /api/v1/expenses": () =>
				json({
					data: [
						{ id: "OLD", number: "0007", public_notes: "x · [OT-1a2b3c4d]" },
					],
				}),
		});
		const res = await invoiceNinjaProvider.pushExpense(
			{ config, secret, fetch },
			payload(),
		);
		expect(res).toMatchObject({
			status: "duplicate",
			exact: true,
			remoteId: "OLD",
		});
		expect(calls).toHaveLength(1);
	});

	it("reuses existing vendor and reports upload failure as a warning", async () => {
		const { fetch, calls } = route({
			"GET /api/v1/expenses": () => json({ data: [] }),
			"GET /api/v1/statics": () => json(statics),
			"GET /api/v1/vendors": () =>
				json({ data: [{ id: "V2", name: "amazon" }] }),
			"POST /api/v1/expenses": () => json({ data: { id: "EXP2" } }),
			"POST /api/v1/expenses/EXP2/upload": () =>
				json({ message: "File too big" }, 422),
		});
		const res = await invoiceNinjaProvider.pushExpense(
			{ config, secret, fetch },
			payload(),
		);
		expect(res.status).toBe("created");
		expect(res.warnings[0]).toMatch(/HTTP 422: File too big/);
		expect(
			calls.some((c) => c.method === "POST" && c.url.endsWith("/vendors")),
		).toBe(false);
	});

	it("maps 401 to auth and unknown currency to unsupported", async () => {
		const a = route({
			"GET /api/v1/ping": () => json({ message: "Invalid token" }, 403),
		});
		const t = await invoiceNinjaProvider.test({
			config,
			secret,
			fetch: a.fetch,
		});
		expect(t.ok).toBe(false);

		const b = route({
			"GET /api/v1/expenses": () => json({ data: [] }),
			"GET /api/v1/statics": () => json(statics),
		});
		await expect(
			invoiceNinjaProvider.pushExpense(
				{ config, secret, fetch: b.fetch },
				payload({ currency: "XYZ" }),
			),
		).rejects.toMatchObject({ code: "unsupported" });
	});

	it("lists options", async () => {
		const { fetch } = route({
			"GET /api/v1/expense_categories": () =>
				json({
					data: [
						{ id: "c1", name: "Supplies" },
						{ id: "c2", name: "Old", is_deleted: true },
					],
				}),
			"GET /api/v1/statics": () => json(statics),
			"GET /api/v1/vendors": () =>
				json({ data: [{ id: "v1", name: "Amazon" }] }),
		});
		const opts = await invoiceNinjaProvider.listOptions({
			config,
			secret,
			fetch,
		});
		expect(opts.expenseAccounts).toEqual([{ id: "c1", label: "Supplies" }]);
		expect(opts.paymentAccounts).toEqual([
			{ id: "5", label: "Credit Card Other", hint: "payment type" },
		]);
		expect(opts.vendors).toEqual([{ id: "v1", label: "Amazon" }]);
	});
});
