/**
 * Money features: card/bank statement reconciliation, historical FX rates,
 * reporting currencies and (advisory) tax treatment notes.
 *
 * Amounts follow the ledger convention: bigint minor units + ISO currency.
 * Statement amounts are normalized so charges are positive and credits
 * (refunds, payments) are negative, whatever the bank's own sign convention.
 */
import {
	bigint,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";
import {
	allocations,
	entities,
	orders,
	paymentMethods,
} from "../ledger/schema";
import {
	TAX_BUSINESS_TYPES,
	TAX_JURISDICTIONS,
	TAX_TREATMENTS,
} from "./constants";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });
const money = (name: string) => bigint(name, { mode: "number" });
const owner = () =>
	text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

/* ───────────────────────── statements ───────────────────────── */

export const STATEMENT_FORMATS = ["csv", "xlsx", "html", "ofx", "qif"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

export const statementImports = pgTable(
	"statement_imports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		fileName: text("file_name").notNull(),
		format: text("format", { enum: STATEMENT_FORMATS }).notNull(),
		presetId: text("preset_id"),
		/** Card/account this statement belongs to (statement → card mapping). */
		paymentMethodId: uuid("payment_method_id").references(
			() => paymentMethods.id,
			{ onDelete: "set null" },
		),
		/** Account number tail found in the file (OFX ACCTID, "Card No." column). */
		accountHint: text("account_hint"),
		sha256: text("sha256").notNull(),
		rowCount: integer("row_count").notNull().default(0),
		insertedCount: integer("inserted_count").notNull().default(0),
		duplicateCount: integer("duplicate_count").notNull().default(0),
		minDate: date("min_date", { mode: "string" }),
		maxDate: date("max_date", { mode: "string" }),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [index("statement_imports_owner_idx").on(t.ownerId, t.createdAt)],
);

export const TRANSACTION_KINDS = [
	"charge",
	"credit",
	"payment",
	"fee",
	"other",
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const TRANSACTION_STATUSES = [
	/** No order found yet. */
	"unmatched",
	/** At least one suggested match awaits confirmation. */
	"suggested",
	/** Confirmed against one or more orders (or an order was created). */
	"matched",
	/** User: "not a purchase" (or a card payment / transfer). */
	"ignored",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const statementTransactions = pgTable(
	"statement_transactions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		importId: uuid("import_id").references(() => statementImports.id, {
			onDelete: "set null",
		}),
		paymentMethodId: uuid("payment_method_id").references(
			() => paymentMethods.id,
			{ onDelete: "set null" },
		),
		postedDate: date("posted_date", { mode: "string" }).notNull(),
		description: text("description").notNull(),
		/** Normalized merchant key ("amazon", "aliexpress", "acme widgets"). */
		merchantKey: text("merchant_key").notNull().default(""),
		/** Charges positive, refunds/credits negative. */
		amountMinor: money("amount_minor").notNull(),
		currency: text("currency").notNull(),
		kind: text("kind", { enum: TRANSACTION_KINDS }).notNull().default("charge"),
		status: text("status", { enum: TRANSACTION_STATUSES })
			.notNull()
			.default("unmatched"),
		/** Bank transaction id (OFX FITID / reference column) when present. */
		externalId: text("external_id"),
		/** Original cells / OFX fields. */
		raw: jsonb("raw").$type<Record<string, string>>().notNull(),
		/** sha256 identity used to make re-imports idempotent. */
		hash: text("hash").notNull(),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("statement_transactions_owner_hash_idx").on(t.ownerId, t.hash),
		index("statement_transactions_owner_date_idx").on(t.ownerId, t.postedDate),
		index("statement_transactions_owner_status_idx").on(t.ownerId, t.status),
		index("statement_transactions_import_idx").on(t.importId),
	],
);

export const MATCH_STATUSES = ["suggested", "confirmed", "rejected"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];
export const MATCH_KINDS = ["single", "split", "refund", "manual"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export const transactionMatches = pgTable(
	"transaction_matches",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		transactionId: uuid("transaction_id")
			.notNull()
			.references(() => statementTransactions.id, { onDelete: "cascade" }),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: MATCH_KINDS }).notNull().default("single"),
		/** Split shipments: all charges of one order share a group key. */
		groupKey: text("group_key"),
		/** 0..1 */
		score: real("score").notNull(),
		status: text("status", { enum: MATCH_STATUSES })
			.notNull()
			.default("suggested"),
		reasons: jsonb("reasons").$type<string[]>().notNull(),
		createdAt: ts("created_at").defaultNow().notNull(),
		decidedAt: ts("decided_at"),
	},
	(t) => [
		uniqueIndex("transaction_matches_pair_idx").on(t.transactionId, t.orderId),
		index("transaction_matches_owner_status_idx").on(t.ownerId, t.status),
		index("transaction_matches_order_idx").on(t.orderId),
	],
);

/* ───────────────────────── FX ───────────────────────── */

export const fxRates = pgTable(
	"fx_rates",
	{
		date: date("date", { mode: "string" }).notNull(),
		base: text("base").notNull(),
		quote: text("quote").notNull(),
		/** 1 base = rate quote. */
		rate: numeric("rate", {
			precision: 20,
			scale: 10,
			mode: "number",
		}).notNull(),
		/** "ecb" (ECB XML) or "frankfurter" (ECB reference rates via API). */
		source: text("source").notNull(),
		fetchedAt: ts("fetched_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.date, t.base, t.quote] }),
		index("fx_rates_pair_date_idx").on(t.base, t.quote, t.date),
	],
);

/** Per-user money preferences (reporting currency). */
export const moneySettings = pgTable("money_settings", {
	ownerId: text("owner_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	reportingCurrency: text("reporting_currency").notNull().default("USD"),
	updatedAt: ts("updated_at").defaultNow().notNull(),
});

/** Per-entity settings kept outside `entities` (reporting currency, tax profile). */
export const entitySettings = pgTable(
	"entity_settings",
	{
		entityId: uuid("entity_id")
			.primaryKey()
			.references(() => entities.id, { onDelete: "cascade" }),
		ownerId: owner(),
		/** NULL = user's reporting currency. */
		reportingCurrency: text("reporting_currency"),
		taxJurisdiction: text("tax_jurisdiction", { enum: TAX_JURISDICTIONS }),
		taxBusinessType: text("tax_business_type", { enum: TAX_BUSINESS_TYPES }),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("entity_settings_owner_idx").on(t.ownerId)],
);

/* ───────────────────────── tax (advisory) ───────────────────────── */

/** User-accepted tax treatment per allocation. Never written automatically. */
export const allocationTax = pgTable(
	"allocation_tax",
	{
		allocationId: uuid("allocation_id")
			.primaryKey()
			.references(() => allocations.id, { onDelete: "cascade" }),
		ownerId: owner(),
		treatment: text("treatment", { enum: TAX_TREATMENTS }).notNull(),
		/** "suggestion" (accepted hint) or "manual". */
		origin: text("origin", { enum: ["suggestion", "manual"] }).notNull(),
		note: text("note"),
		/** Allocation amount when accepted (flags later amount changes). */
		amountMinor: money("amount_minor").notNull(),
		currency: text("currency").notNull(),
		acceptedAt: ts("accepted_at").defaultNow().notNull(),
	},
	(t) => [index("allocation_tax_owner_idx").on(t.ownerId, t.treatment)],
);

export {
	TAX_BUSINESS_TYPES,
	TAX_JURISDICTIONS,
	TAX_TREATMENTS,
	type TaxBusinessType,
	type TaxJurisdiction,
	type TaxTreatment,
} from "./constants";
