import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at", {
			mode: "date",
			withTimezone: true,
		}).notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_user_idx").on(table.userId)],
);

export const account = pgTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", {
			mode: "date",
			withTimezone: true,
		}),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
			mode: "date",
			withTimezone: true,
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("account_provider_identity_idx").on(
			table.providerId,
			table.accountId,
		),
		index("account_user_idx").on(table.userId),
	],
);

export const verification = pgTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", {
			mode: "date",
			withTimezone: true,
		}).notNull(),
		createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const apikey = pgTable(
	"apikey",
	{
		id: text("id").primaryKey(),
		configId: text("config_id").default("default").notNull(),
		name: text("name"),
		start: text("start"),
		referenceId: text("reference_id").notNull(),
		prefix: text("prefix"),
		key: text("key").notNull(),
		refillInterval: integer("refill_interval"),
		refillAmount: integer("refill_amount"),
		lastRefillAt: timestamp("last_refill_at", {
			mode: "date",
			withTimezone: true,
		}),
		enabled: boolean("enabled").default(true),
		rateLimitEnabled: boolean("rate_limit_enabled").default(true),
		rateLimitTimeWindow: integer("rate_limit_time_window").default(60_000),
		rateLimitMax: integer("rate_limit_max").default(1_000),
		requestCount: integer("request_count").default(0),
		remaining: integer("remaining"),
		lastRequest: timestamp("last_request", {
			mode: "date",
			withTimezone: true,
		}),
		expiresAt: timestamp("expires_at", {
			mode: "date",
			withTimezone: true,
		}),
		createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
			.defaultNow()
			.notNull(),
		permissions: text("permissions"),
		metadata: text("metadata"),
	},
	(table) => [
		index("apikey_config_id_idx").on(table.configId),
		index("apikey_reference_id_idx").on(table.referenceId),
		index("apikey_key_idx").on(table.key),
	],
);

export {
	budgets,
	invoiceNinjaClaimDrafts,
	invoiceNinjaClaimSettings,
	notificationPreferences,
	paperlessPushes,
	webhookEndpoints,
} from "../features/automation/schema";
export * from "../features/backup/schema";
export {
	enrichmentTasks,
	imports,
	importTemplates,
	ingressSources,
} from "../features/ingress/schema";
export {
	allocations,
	captures,
	categories,
	claims,
	connections,
	documents,
	entities,
	exports,
	orderCaptures,
	orderItems,
	orders,
	paymentMethods,
	rules,
	shipments,
} from "../features/ledger/schema";
export * from "../features/lifecycle/schema";
export * from "../features/money/schema";
export {
	captureRetentionSettings,
	parserReparseProgress,
} from "../features/ops/schema";
export * from "../features/sharing/schema";
export { auditEvents } from "../integrations/audit-log/schema";
export {
	flagDefinitions,
	flagOverrides,
} from "../integrations/feature-flags/schema";
export {
	bindings as invoiceNinjaBindings,
	clients as invoiceNinjaClients,
	inbox as invoiceNinjaInbox,
	invoices as invoiceNinjaInvoices,
	operations as invoiceNinjaOperations,
} from "../integrations/invoice-ninja/schema";
export { notifications } from "../integrations/notifications/schema";
export { fileUiFiles } from "./file-ui-schema";
