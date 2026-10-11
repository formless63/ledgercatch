/**
 * Provider-neutral accounting export contract (see docs/SPEC.md → Connectors).
 *
 * Providers are pure: they receive validated config + decrypted secret + an
 * export payload and return a result. Persistence (connections / exports
 * rows), job scheduling and secret decryption live outside this module.
 */
import { z } from "zod";

export const CONNECTOR_PROVIDER_IDS = ["custom_http", "invoice_ninja"] as const;
export type ConnectorProviderId = (typeof CONNECTOR_PROVIDER_IDS)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ConnectorErrorCode =
	| "auth"
	| "validation"
	| "unsupported"
	| "remote"
	| "network";

/**
 * Typed failure thrown by providers. `retryable` tells the job runner whether
 * a retry could succeed without user action (network blips, 5xx, 429).
 * Messages are safe to show to the user and to store in `exports.error`
 * (never contain secrets).
 */
export class ConnectorError extends Error {
	readonly code: ConnectorErrorCode;
	readonly retryable: boolean;
	readonly status?: number;

	constructor(
		code: ConnectorErrorCode,
		message: string,
		opts: { retryable?: boolean; status?: number; cause?: unknown } = {},
	) {
		super(
			message,
			opts.cause === undefined ? undefined : { cause: opts.cause },
		);
		this.name = "ConnectorError";
		this.code = code;
		this.retryable = opts.retryable ?? code === "network";
		this.status = opts.status;
	}
}

export function isConnectorError(err: unknown): err is ConnectorError {
	return err instanceof ConnectorError;
}

// ---------------------------------------------------------------------------
// Settings form metadata
// ---------------------------------------------------------------------------

export type ConnectorFieldType =
	| "url"
	| "text"
	| "password"
	| "select"
	| "json";

export interface ConnectorField {
	key: string;
	label: string;
	type: ConnectorFieldType;
	help?: string;
	placeholder?: string;
	required?: boolean;
	/** Only for type "select". */
	options?: Array<{ value: string; label: string }>;
}

// ---------------------------------------------------------------------------
// Mappings (shared config convention)
// ---------------------------------------------------------------------------

/**
 * Every provider config embeds these mapping keys. Values are REMOTE ids as
 * strings (even when the remote uses numeric ids — providers convert).
 * Keys: local `categories.id` / `payment_methods.id`.
 */
export const mappingConfigSchema = z.object({
	categoryAccountMap: z.record(z.string(), z.string()).default({}),
	paymentAccountMap: z.record(z.string(), z.string()).default({}),
	defaultExpenseAccountId: z.string().min(1).optional(),
	defaultPaymentAccountId: z.string().min(1).optional(),
});
export type MappingConfig = z.output<typeof mappingConfigSchema>;

/** http(s) URL, trimmed, trailing slashes removed. */
export const baseUrlSchema = z
	.url({ protocol: /^https?$/ })
	.trim()
	.transform((s) => s.replace(/\/+$/, ""));

export function resolveMapping(
	config: Partial<MappingConfig>,
	local: { categoryId?: string | null; paymentMethodId?: string | null },
): { expenseAccountId?: string; paymentAccountId?: string } {
	const expense =
		(local.categoryId
			? config.categoryAccountMap?.[local.categoryId]
			: undefined) ||
		config.defaultExpenseAccountId ||
		undefined;
	const payment =
		(local.paymentMethodId
			? config.paymentAccountMap?.[local.paymentMethodId]
			: undefined) ||
		config.defaultPaymentAccountId ||
		undefined;
	return { expenseAccountId: expense, paymentAccountId: payment };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** ISO-4217 minor-unit exponent (JPY 0, USD 2, KWD 3). Falls back to 2. */
export function currencyExponent(currency: string): number {
	try {
		const digits = new Intl.NumberFormat("en", {
			style: "currency",
			currency: currency.toUpperCase(),
		}).resolvedOptions().maximumFractionDigits;
		return typeof digits === "number" ? digits : 2;
	} catch {
		return 2;
	}
}

/**
 * Convert integer minor units to a plain decimal string using the currency's
 * exponent: (12345, "USD") → "123.45"; (1200, "JPY") → "1200";
 * (-5, "USD") → "-0.05". No grouping separators, no float math.
 */
export function minorToDecimalString(
	minor: number | bigint,
	currency: string,
): string {
	if (typeof minor === "number" && !Number.isSafeInteger(minor)) {
		throw new ConnectorError(
			"validation",
			`Amount ${minor} is not an integer number of minor units`,
		);
	}
	const big = BigInt(minor);
	const negative = big < 0n;
	const digits = (negative ? -big : big).toString();
	const exp = currencyExponent(currency);
	let out: string;
	if (exp === 0) {
		out = digits;
	} else {
		const padded = digits.padStart(exp + 1, "0");
		out = `${padded.slice(0, -exp)}.${padded.slice(-exp)}`;
	}
	return negative ? `-${out}` : out;
}

// ---------------------------------------------------------------------------
// Payload / results
// ---------------------------------------------------------------------------

export interface ExpenseDocument {
	fileName: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	/** documents.kind (invoice, receipt, …) — used to prefer invoices/receipts. */
	kind?: string;
	load: () => Promise<Uint8Array>;
}

export interface ExpensePayload {
	/** Our stable idempotency token, e.g. "OT-1a2b3c4d" (from allocation id). */
	reference: string;
	/** Human order ref, e.g. "amazon 113-1234567-1234567". */
	orderRef: string;
	/** YYYY-MM-DD */
	date: string;
	vendorName: string;
	/** Decimal string from minorToDecimalString. */
	amount: string;
	/** ISO-4217 */
	currency: string;
	memo: string;
	/** Remote ids from resolveMapping(). */
	expenseAccountId?: string;
	paymentAccountId?: string;
	reimbursable: boolean;
	lineSummary: string[];
	documents: ExpenseDocument[];
}

export type PushResult =
	| {
			status: "created";
			remoteId: string;
			remoteUrl?: string;
			warnings: string[];
	  }
	| {
			status: "duplicate";
			remoteId?: string;
			remoteUrl?: string;
			reason: string;
			/** true = matched our reference (definitely ours); false = fuzzy match. */
			exact: boolean;
			warnings: string[];
	  };

export interface PushOptions {
	/**
	 * Skip fuzzy (amount/date/vendor/file hash) duplicate checks after a user
	 * confirmed the expense is genuinely new. Reference matches always win.
	 */
	skipFuzzyDuplicateCheck?: boolean;
}

export interface AttachDocumentInput {
	fileName: string;
	contentType: string;
	bytes: Uint8Array;
	sha256: string;
}

export type AttachResult =
	| { status: "attached" }
	| { status: "skipped"; reason: string };

export type TestResult =
	| { ok: true; summary: string }
	| { ok: false; error: string };

export interface ConnectorOption {
	id: string;
	label: string;
	hint?: string;
}

export interface ConnectorOptions {
	expenseAccounts: ConnectorOption[];
	paymentAccounts: ConnectorOption[];
	vendors?: ConnectorOption[];
}

export interface ConnectorContext<Config, Secret> {
	config: Config;
	secret: Secret;
	/** Injected for tests; defaults to global fetch. */
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export interface ConnectorProvider<Config, Secret> {
	id: ConnectorProviderId;
	label: string;
	description: string;
	configSchema: z.ZodType<Config>;
	secretSchema: z.ZodType<Secret>;
	configFields: ConnectorField[];
	secretFields: ConnectorField[];
	/** Never throws; returns a user-facing error string. */
	test(ctx: ConnectorContext<Config, Secret>): Promise<TestResult>;
	/** Throws ConnectorError. */
	listOptions(ctx: ConnectorContext<Config, Secret>): Promise<ConnectorOptions>;
	/**
	 * Idempotent push: checks for our reference remotely first. Attaches
	 * payload.documents itself (attachment failures become warnings, never a
	 * thrown error, since the expense already exists). Throws ConnectorError.
	 */
	pushExpense(
		ctx: ConnectorContext<Config, Secret>,
		payload: ExpensePayload,
		opts?: PushOptions,
	): Promise<PushResult>;
	/** Re-attach / attach later. Throws ConnectorError. */
	attachDocument?(
		ctx: ConnectorContext<Config, Secret>,
		remoteId: string,
		doc: AttachDocumentInput,
	): Promise<AttachResult>;
}

/** Text appended to memos so the reference search can find prior pushes. */
export function referenceTag(reference: string): string {
	return `[${reference}]`;
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
