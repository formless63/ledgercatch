/**
 * Ingress beyond the browser extension: polled/pushed sources (IMAP, inbound
 * email webhooks, Paperless-ngx, store APIs), spreadsheet imports, and
 * enrichment tasks that fill in partial orders. Everything still lands in
 * `captures` so parsing, rules and allocation stay one pipeline.
 */
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";
import { documents, orders } from "../ledger/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });
const owner = () =>
	text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

export const INGRESS_SOURCE_KINDS = [
	"imap",
	"inbound_email",
	"paperless",
	"digikey_api",
] as const;
export type IngressSourceKind = (typeof INGRESS_SOURCE_KINDS)[number];

export const ingressSources = pgTable(
	"ingress_sources",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		kind: text("kind", { enum: INGRESS_SOURCE_KINDS }).notNull(),
		name: text("name").notNull(),
		/** Non-secret settings, validated by the source module. */
		config: jsonb("config").$type<Record<string, unknown>>().notNull(),
		secretCiphertext: text("secret_ciphertext"),
		/** Opaque per-source progress (IMAP UID, Paperless modified-after, …). */
		cursor: jsonb("cursor").$type<Record<string, unknown>>(),
		enabled: text("enabled", { enum: ["on", "off"] })
			.notNull()
			.default("on"),
		/** Polling interval in minutes (pollers only). */
		intervalMinutes: integer("interval_minutes").notNull().default(10),
		status: text("status", { enum: ["untested", "ok", "error"] })
			.notNull()
			.default("untested"),
		lastRunAt: ts("last_run_at"),
		lastError: text("last_error"),
		/** Random token for push sources (inbound webhooks), stored hashed. */
		pushTokenHash: text("push_token_hash"),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("ingress_sources_owner_idx").on(t.ownerId),
		uniqueIndex("ingress_sources_push_token_idx").on(t.pushTokenHash),
	],
);

export const IMPORT_STATUSES = [
	"uploaded",
	"mapped",
	"processing",
	"done",
	"failed",
] as const;

/** Saved column mappings for CSV/XLSX exports from a given store. */
export const importTemplates = pgTable(
	"import_templates",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		name: text("name").notNull(),
		source: text("source").notNull(),
		/** Normalized header list used to auto-detect this template. */
		headerSignature: text("header_signature").notNull(),
		mapping: jsonb("mapping").$type<Record<string, unknown>>().notNull(),
		options: jsonb("options").$type<Record<string, unknown>>().notNull(),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("import_templates_owner_idx").on(t.ownerId, t.headerSignature)],
);

/** One uploaded spreadsheet; rows become captures once mapped. */
export const imports = pgTable(
	"imports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		documentId: uuid("document_id").references(() => documents.id, {
			onDelete: "set null",
		}),
		fileName: text("file_name").notNull(),
		source: text("source").notNull().default("generic"),
		templateId: uuid("template_id").references(() => importTemplates.id, {
			onDelete: "set null",
		}),
		status: text("status", { enum: IMPORT_STATUSES })
			.notNull()
			.default("uploaded"),
		/** Parsed header + preview rows for the mapping UI. */
		preview: jsonb("preview").$type<Record<string, unknown>>(),
		mapping: jsonb("mapping").$type<Record<string, unknown>>(),
		rowCount: integer("row_count").notNull().default(0),
		ordersCreated: integer("orders_created").notNull().default(0),
		ordersUpdated: integer("orders_updated").notNull().default(0),
		error: text("error"),
		createdAt: ts("created_at").defaultNow().notNull(),
		finishedAt: ts("finished_at"),
	},
	(t) => [index("imports_owner_idx").on(t.ownerId, t.createdAt)],
);

export const ENRICHMENT_KINDS = ["extension_fetch", "provider_api"] as const;
export const ENRICHMENT_STATUSES = [
	"pending",
	"claimed",
	"done",
	"failed",
	"skipped",
] as const;

/**
 * "Go get the rest": a partial order (e.g. from an email) that the extension
 * (with the user's store session) or a store API should complete.
 */
export const enrichmentTasks = pgTable(
	"enrichment_tasks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ENRICHMENT_KINDS }).notNull(),
		source: text("source").notNull(),
		externalOrderId: text("external_order_id").notNull(),
		/** Page the extension should fetch (order detail / invoice). */
		url: text("url"),
		status: text("status", { enum: ENRICHMENT_STATUSES })
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		claimedAt: ts("claimed_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
		finishedAt: ts("finished_at"),
	},
	(t) => [
		uniqueIndex("enrichment_order_kind_idx").on(t.orderId, t.kind),
		index("enrichment_owner_status_idx").on(t.ownerId, t.status),
	],
);
