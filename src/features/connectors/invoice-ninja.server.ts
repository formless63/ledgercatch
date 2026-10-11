/**
 * Invoice Ninja v5 connector (REST, `X-API-TOKEN`).
 * Expense categories ↔ expense accounts; payment types ↔ payment accounts
 * (Invoice Ninja has no ledger accounts — setting payment_type_id +
 * payment_date marks the expense as paid).
 */
import { z } from "zod";
import { boundedFetch, httpError, parseJson } from "./http.server";
import {
	type AttachDocumentInput,
	type AttachResult,
	baseUrlSchema,
	type ConnectorContext,
	ConnectorError,
	type ConnectorOption,
	type ConnectorOptions,
	type ConnectorProvider,
	type ExpensePayload,
	errorMessage,
	mappingConfigSchema,
	type PushResult,
	referenceTag,
	type TestResult,
} from "./types";

const LABEL = "Invoice Ninja";
const AUTH_HINT =
	"Check the API token (Settings → Account Management → Integrations → API tokens) and that the URL points at the right Invoice Ninja instance.";
const MAX_PAGES = 10;
const PER_PAGE = 100;

export const invoiceNinjaConfigSchema = mappingConfigSchema.extend({
	baseUrl: baseUrlSchema,
	/**
	 * Prefix of web-app links; `/expenses/{id}/edit` is appended. Defaults to
	 * `${baseUrl}/#` (self-hosted hash router). Hosted: https://app.invoicing.co
	 */
	webAppUrl: baseUrlSchema.optional(),
});
export type InvoiceNinjaConfig = z.output<typeof invoiceNinjaConfigSchema>;

export const invoiceNinjaSecretSchema = z.object({
	apiToken: z.string().trim().min(8, "API token looks too short"),
});
export type InvoiceNinjaSecret = z.output<typeof invoiceNinjaSecretSchema>;

type Ctx = ConnectorContext<InvoiceNinjaConfig, InvoiceNinjaSecret>;

interface NamedEntity {
	id: string;
	name: string;
	is_deleted?: boolean;
	archived_at?: number | null;
}
interface IninjaExpense {
	id: string;
	number?: string;
	amount?: number | string;
	date?: string;
	public_notes?: string;
	private_notes?: string;
	transaction_reference?: string;
	is_deleted?: boolean;
}
interface Statics {
	currencies?: Array<{ id: string | number; code: string; name?: string }>;
	payment_types?: Array<{ id: string | number; name: string }>;
}
interface ListBody<T> {
	data?: T[];
	meta?: { pagination?: { total_pages?: number; current_page?: number } };
}

function headers(ctx: Ctx, json = true): Record<string, string> {
	return {
		"X-API-TOKEN": ctx.secret.apiToken,
		"X-Requested-With": "XMLHttpRequest",
		Accept: "application/json",
		...(json ? { "Content-Type": "application/json" } : {}),
	};
}

async function request<T>(
	ctx: Ctx,
	method: string,
	path: string,
	body?: unknown,
	opts: { timeoutMs?: number } = {},
): Promise<T> {
	const secrets = [ctx.secret.apiToken];
	const isForm = body instanceof FormData;
	const res = await boundedFetch(`${ctx.config.baseUrl}${path}`, {
		label: LABEL,
		method,
		headers: headers(ctx, !isForm && body !== undefined),
		body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
		fetch: ctx.fetch,
		signal: ctx.signal,
		secrets,
		timeoutMs: opts.timeoutMs,
	});
	if (!res.ok) throw httpError(res, LABEL, secrets, AUTH_HINT);
	return parseJson<T>(res.text, LABEL);
}

/** Unwrap `{data: X}` (Fractal item) or plain X. */
function unwrap<T>(body: unknown): T {
	if (body && typeof body === "object" && "data" in body) {
		return (body as { data: T }).data;
	}
	return body as T;
}

async function listAll<T>(
	ctx: Ctx,
	path: string,
	query: Record<string, string> = {},
): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const qs = new URLSearchParams({
			...query,
			per_page: String(PER_PAGE),
			page: String(page),
		});
		const body = await request<ListBody<T>>(ctx, "GET", `${path}?${qs}`);
		out.push(...(body.data ?? []));
		const total = body.meta?.pagination?.total_pages ?? 1;
		if (page >= total || (body.data ?? []).length === 0) break;
	}
	return out;
}

const active = (e: NamedEntity) => !e.is_deleted && !e.archived_at;

async function getStatics(ctx: Ctx): Promise<Statics> {
	return request<Statics>(ctx, "GET", "/api/v1/statics");
}

function webUrl(ctx: Ctx, id: string): string {
	return `${ctx.config.webAppUrl ?? `${ctx.config.baseUrl}/#`}/expenses/${id}/edit`;
}

export function buildInvoiceNinjaNotes(payload: ExpensePayload): {
	public_notes: string;
	private_notes: string;
} {
	const tag = referenceTag(payload.reference);
	const publicParts = [payload.memo.trim(), payload.orderRef, tag].filter(
		Boolean,
	);
	const privateLines = [
		`Exported by ledgercatch ${tag}`,
		`Order: ${payload.orderRef}`,
		...(payload.reimbursable ? ["Paid personally — reimbursable"] : []),
		...payload.lineSummary.map((l) => `- ${l}`),
	];
	return {
		public_notes: publicParts.join(" · "),
		private_notes: privateLines.join("\n"),
	};
}

async function attach(
	ctx: Ctx,
	remoteId: string,
	doc: AttachDocumentInput,
): Promise<AttachResult> {
	const form = new FormData();
	form.append("_method", "PUT");
	form.append(
		"documents[]",
		new Blob([new Uint8Array(doc.bytes)], { type: doc.contentType }),
		doc.fileName,
	);
	await request(
		ctx,
		"POST",
		`/api/v1/expenses/${encodeURIComponent(remoteId)}/upload`,
		form,
		{
			timeoutMs: 60_000,
		},
	);
	return { status: "attached" };
}

export const invoiceNinjaProvider: ConnectorProvider<
	InvoiceNinjaConfig,
	InvoiceNinjaSecret
> = {
	id: "invoice_ninja",
	label: "Invoice Ninja",
	description:
		"Creates expenses (with documents) in Invoice Ninja v5. Categories map to expense categories; payment methods map to payment types.",
	configSchema: invoiceNinjaConfigSchema,
	secretSchema: invoiceNinjaSecretSchema,
	configFields: [
		{
			key: "baseUrl",
			label: "Invoice Ninja API URL",
			type: "url",
			required: true,
			placeholder: "https://invoicing.co",
			help: "Hosted: https://invoicing.co. Self-hosted: your instance root (API lives at /api/v1).",
		},
		{
			key: "webAppUrl",
			label: "Web app URL (for links)",
			type: "url",
			placeholder: "https://app.invoicing.co",
			help: "Optional. Links open {url}/expenses/{id}/edit. Defaults to {API URL}/# for self-hosted installs.",
		},
	],
	secretFields: [
		{
			key: "apiToken",
			label: "API token",
			type: "password",
			required: true,
			help: "Settings → Account Management → Integrations → API tokens.",
		},
	],

	async test(ctx): Promise<TestResult> {
		try {
			const ping = await request<{ company_name?: string; user_name?: string }>(
				ctx,
				"GET",
				"/api/v1/ping",
			);
			const who = [ping.company_name, ping.user_name]
				.filter(Boolean)
				.join(" / ");
			return { ok: true, summary: who ? `Connected to ${who}` : "Connected" };
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	},

	async listOptions(ctx): Promise<ConnectorOptions> {
		const [categories, statics, vendors] = await Promise.all([
			listAll<NamedEntity>(ctx, "/api/v1/expense_categories"),
			getStatics(ctx),
			listAll<NamedEntity>(ctx, "/api/v1/vendors"),
		]);
		const named = (e: NamedEntity): ConnectorOption => ({
			id: String(e.id),
			label: e.name,
		});
		return {
			expenseAccounts: categories.filter(active).map(named),
			paymentAccounts: (statics.payment_types ?? []).map((p) => ({
				id: String(p.id),
				label: p.name,
				hint: "payment type",
			})),
			vendors: vendors.filter(active).map(named),
		};
	},

	async pushExpense(ctx, payload): Promise<PushResult> {
		const amount = Number(payload.amount);
		if (!Number.isFinite(amount) || amount <= 0) {
			throw new ConnectorError(
				"validation",
				`Invoice Ninja needs a positive amount, got "${payload.amount}"`,
			);
		}
		const warnings: string[] = [];
		const tag = referenceTag(payload.reference);

		// 1. Prior push? `filter` searches public_notes (where we put the tag).
		const prior = await listAll<IninjaExpense>(ctx, "/api/v1/expenses", {
			filter: payload.reference,
		});
		const mine = prior.find(
			(e) =>
				!e.is_deleted &&
				`${e.public_notes ?? ""}\n${e.private_notes ?? ""}`.includes(tag),
		);
		if (mine) {
			return {
				status: "duplicate",
				exact: true,
				remoteId: mine.id,
				remoteUrl: webUrl(ctx, mine.id),
				reason: `Already exported as Invoice Ninja expense ${mine.number ?? mine.id}`,
				warnings,
			};
		}

		// 2. Currency id.
		const statics = await getStatics(ctx);
		const code = payload.currency.toUpperCase();
		const currency = statics.currencies?.find(
			(c) => c.code?.toUpperCase() === code,
		);
		if (!currency) {
			throw new ConnectorError(
				"unsupported",
				`Invoice Ninja does not know currency ${code}`,
			);
		}

		// 3. Vendor (exact name match, else create).
		const want = payload.vendorName.trim().toLowerCase();
		const candidates = await listAll<NamedEntity>(ctx, "/api/v1/vendors", {
			filter: payload.vendorName.trim(),
		});
		let vendor = candidates.find(
			(v) => !v.is_deleted && v.name.trim().toLowerCase() === want,
		);
		if (!vendor) {
			vendor = unwrap<NamedEntity>(
				await request(ctx, "POST", "/api/v1/vendors", {
					name: payload.vendorName.trim(),
				}),
			);
		}

		// 4. Expense.
		const notes = buildInvoiceNinjaNotes(payload);
		const body: Record<string, unknown> = {
			vendor_id: vendor.id,
			amount,
			date: payload.date,
			currency_id: String(currency.id),
			...notes,
			transaction_reference: payload.orderRef,
			should_be_invoiced: false,
		};
		if (payload.expenseAccountId) body.category_id = payload.expenseAccountId;
		if (payload.paymentAccountId) {
			body.payment_type_id = payload.paymentAccountId;
			body.payment_date = payload.date;
		}
		const created = unwrap<IninjaExpense>(
			await request(ctx, "POST", "/api/v1/expenses", body),
		);
		if (!created?.id) {
			throw new ConnectorError(
				"remote",
				"Invoice Ninja did not return an expense id",
			);
		}

		// 5. Documents (all of them).
		for (const doc of payload.documents) {
			try {
				const bytes = await doc.load();
				await attach(ctx, created.id, {
					fileName: doc.fileName,
					contentType: doc.contentType,
					bytes,
					sha256: doc.sha256,
				});
			} catch (err) {
				warnings.push(
					`Upload failed for ${doc.fileName}: ${errorMessage(err)}`,
				);
			}
		}

		return {
			status: "created",
			remoteId: created.id,
			remoteUrl: webUrl(ctx, created.id),
			warnings,
		};
	},

	attachDocument: attach,
};
