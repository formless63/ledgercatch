/**
 * Automation tables: notification preferences, budgets, outbound webhook
 * endpoints, Invoice Ninja claim drafts and Paperless push receipts.
 * Capability-owned tables (notification, feature_flag, invoice_ninja_*) live
 * in src/integrations/<capability>/schema.ts.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";
import { ingressSources } from "../ingress/schema";
import {
	categories,
	claims,
	connections,
	documents,
	entities,
} from "../ledger/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });
const owner = () =>
	text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

export const ALERT_KINDS = [
	"inbox",
	"missingInvoices",
	"pendingReimbursements",
	"exports",
	"captures",
	"enrichment",
	"budgets",
	"captureFailures",
	"exportFailures",
	"claimPaid",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertToggles = Partial<Record<AlertKind, boolean>>;
export type ChannelToggles = { inApp: boolean; email: boolean; ntfy: boolean };

export const notificationPreferences = pgTable("notification_preferences", {
	ownerId: text("owner_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	channels: jsonb("channels")
		.$type<ChannelToggles>()
		.notNull()
		.default({ inApp: true, email: false, ntfy: false }),
	/** ntfy topic on the operator-configured NTFY_BASE_URL server. */
	ntfyTopic: text("ntfy_topic"),
	digestEnabled: boolean("digest_enabled").notNull().default(true),
	/** Local hour (0–23) in `timezone` at which the daily digest is sent. */
	digestHour: integer("digest_hour").notNull().default(8),
	timezone: text("timezone").notNull().default("UTC"),
	alerts: jsonb("alerts").$type<AlertToggles>().notNull().default({}),
	/** Local date (YYYY-MM-DD) of the last digest, so it runs once per day. */
	lastDigestDate: text("last_digest_date"),
	updatedAt: ts("updated_at").defaultNow().notNull(),
});

export const BUDGET_PERIODS = ["month", "quarter", "year"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const budgets = pgTable(
	"budgets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		entityId: uuid("entity_id")
			.notNull()
			.references(() => entities.id, { onDelete: "cascade" }),
		/** NULL = all categories for the entity. */
		categoryId: uuid("category_id").references(() => categories.id, {
			onDelete: "cascade",
		}),
		period: text("period", { enum: BUDGET_PERIODS }).notNull(),
		amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
		currency: text("currency").notNull(),
		/** Warn when spend reaches this percentage of the budget (1–100). */
		thresholdPct: integer("threshold_pct").notNull().default(80),
		enabled: boolean("enabled").notNull().default(true),
		/** Period key (2026-10, 2026-Q4, 2026) of the last alert sent. */
		alertedPeriod: text("alerted_period"),
		/** Highest level alerted in `alertedPeriod`: "threshold" or "exceeded". */
		alertedLevel: text("alerted_level", { enum: ["threshold", "exceeded"] }),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("budgets_owner_idx").on(t.ownerId, t.entityId)],
);

export const webhookEndpoints = pgTable(
	"webhook_endpoints",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		name: text("name").notNull(),
		url: text("url").notNull(),
		/** Encrypted Standard Webhooks `whsec_` signing secret. */
		secretCiphertext: text("secret_ciphertext").notNull(),
		/** Subscribed event types; empty = all. */
		events: text("events").array().notNull().default(sql`'{}'`),
		enabled: boolean("enabled").notNull().default(true),
		lastDeliveryAt: ts("last_delivery_at"),
		lastOutcome: text("last_outcome"),
		lastError: text("last_error"),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("webhook_endpoints_owner_idx").on(t.ownerId)],
);

/** Per Invoice Ninja connection: reimbursement-invoice settings and trusted draft policy. */
export const invoiceNinjaClaimSettings = pgTable(
	"invoice_ninja_claim_settings",
	{
		connectionId: uuid("connection_id")
			.primaryKey()
			.references(() => connections.id, { onDelete: "cascade" }),
		ownerId: owner(),
		/** Create an unsent draft automatically when a claim is submitted. */
		autoDraft: boolean("auto_draft").notNull().default(false),
		/** Operator-verified draft policy (see docs/AUTOMATION.md); NULL denies drafts. */
		policy: jsonb("policy").$type<{
			currencyId: string;
			currency: string;
			configurationIdentity: string;
			verifiedAt: string;
		}>(),
		/** Possession secret for the X-Invoice-Ninja-Webhook-Secret header. */
		webhookSecretCiphertext: text("webhook_secret_ciphertext"),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("invoice_ninja_claim_settings_owner_idx").on(t.ownerId)],
);

export const invoiceNinjaClaimDrafts = pgTable(
	"invoice_ninja_claim_drafts",
	{
		claimId: uuid("claim_id")
			.primaryKey()
			.references(() => claims.id, { onDelete: "cascade" }),
		ownerId: owner(),
		connectionId: uuid("connection_id")
			.notNull()
			.references(() => connections.id, { onDelete: "cascade" }),
		/** Invoice Ninja capability operation (create_draft). */
		operationId: uuid("operation_id").notNull(),
		paidSyncedAt: ts("paid_synced_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("invoice_ninja_claim_drafts_operation_idx").on(t.operationId),
	],
);

export const paperlessPushes = pgTable(
	"paperless_pushes",
	{
		sourceId: uuid("source_id")
			.notNull()
			.references(() => ingressSources.id, { onDelete: "cascade" }),
		documentId: uuid("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		ownerId: owner(),
		status: text("status", { enum: ["queued", "pushed", "failed"] })
			.notNull()
			.default("queued"),
		taskId: text("task_id"),
		error: text("error"),
		createdAt: ts("created_at").defaultNow().notNull(),
		pushedAt: ts("pushed_at"),
	},
	(t) => [primaryKey({ columns: [t.sourceId, t.documentId] })],
);
