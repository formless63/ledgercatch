/**
 * Domain schema: captures → orders → allocations → exports.
 * See docs/SPEC.md for semantics. Money is bigint minor units + ISO currency.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";
import {
	tsvector,
	weightedSearchVector,
} from "../../integrations/search/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });
const money = (name: string) => bigint(name, { mode: "number" });
const owner = () =>
	text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

export const ENTITY_COLORS = [
	"indigo",
	"emerald",
	"sky",
	"purple",
	"amber",
	"pink",
	"teal",
] as const;
export type EntityColor = (typeof ENTITY_COLORS)[number];

export const entities = pgTable(
	"entities",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		name: text("name").notNull(),
		shortName: text("short_name"),
		kind: text("kind", { enum: ["personal", "business"] }).notNull(),
		color: text("color", { enum: ENTITY_COLORS }).notNull().default("sky"),
		isDefault: boolean("is_default").notNull().default(false),
		sort: integer("sort").notNull().default(0),
		archivedAt: ts("archived_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("entities_owner_idx").on(t.ownerId, t.sort)],
);

export const categories = pgTable(
	"categories",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		/** NULL = shared across entities. */
		entityId: uuid("entity_id").references(() => entities.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		code: text("code"),
		archivedAt: ts("archived_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [index("categories_owner_idx").on(t.ownerId)],
);

export const paymentMethods = pgTable(
	"payment_methods",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		label: text("label").notNull(),
		brand: text("brand").notNull().default(""),
		last4: text("last4").notNull().default(""),
		/** Entity whose money funds this method; drives reimbursement. */
		payingEntityId: uuid("paying_entity_id").references(() => entities.id, {
			onDelete: "set null",
		}),
		archivedAt: ts("archived_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("payment_methods_owner_card_idx").on(
			t.ownerId,
			t.brand,
			t.last4,
		),
	],
);

export const CAPTURE_STATUSES = [
	"pending",
	"parsed",
	"no_orders",
	"needs_review",
	"failed",
	"ignored",
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export const captures = pgTable(
	"captures",
	{
		/** Client-generated captureId. */
		id: uuid("id").primaryKey(),
		ownerId: owner(),
		source: text("source").notNull(),
		kind: text("kind").notNull(),
		trigger: text("trigger").notNull(),
		pageType: text("page_type").notNull().default("unknown"),
		pageUrl: text("page_url").notNull(),
		pageTitle: text("page_title").notNull().default(""),
		requestUrl: text("request_url"),
		capturedAt: ts("captured_at").notNull(),
		/** Client-local date retained before timestamptz normalizes the instant. */
		capturedLocalDate: date("captured_local_date", { mode: "string" }),
		receivedAt: ts("received_at").defaultNow().notNull(),
		extensionVersion: text("extension_version").notNull().default(""),
		contentHash: text("content_hash").notNull(),
		/** JSON payload body (kind api_json). */
		bodyJson: jsonb("body_json"),
		/** HTML (html_snapshot) or visible text (page_text). */
		bodyText: text("body_text"),
		screenshotDocumentId: uuid("screenshot_document_id"),
		note: text("note"),
		orderIdHints: text("order_id_hints").array().notNull().default(sql`'{}'`),
		/** How it arrived: extension, upload, email, import, paperless, agent, api. */
		channel: text("channel").notNull().default("extension"),
		/** Idempotency key within a channel (Message-ID, Paperless id, row hash…). */
		sourceRef: text("source_ref"),
		/** Original file for document/email captures. */
		documentId: uuid("document_id"),
		status: text("status", { enum: CAPTURE_STATUSES })
			.notNull()
			.default("pending"),
		parserId: text("parser_id"),
		parserVersion: integer("parser_version"),
		error: text("error"),
		ordersFound: integer("orders_found").notNull().default(0),
		parsedAt: ts("parsed_at"),
	},
	(t) => [
		uniqueIndex("captures_owner_hash_idx").on(t.ownerId, t.contentHash),
		uniqueIndex("captures_owner_channel_ref_idx").on(
			t.ownerId,
			t.channel,
			t.sourceRef,
		),
		index("captures_owner_received_idx").on(t.ownerId, t.receivedAt),
		index("captures_status_idx").on(t.status),
	],
);

export const ORDER_STATUSES = [
	"placed",
	"processing",
	"shipped",
	"delivered",
	"cancelled",
	"returned",
	"unknown",
] as const;
export const REVIEW_STATES = ["inbox", "filed", "ignored"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const orders = pgTable(
	"orders",
	{
		searchVector: tsvector("search_vector").generatedAlwaysAs(
			weightedSearchVector(
				sql`"external_order_id" || ' ' || coalesce("merchant_name", '')`,
				sql`coalesce("items_text", '') || ' ' || coalesce("notes", '')`,
			),
		),
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		source: text("source").notNull(),
		externalOrderId: text("external_order_id").notNull(),
		merchantName: text("merchant_name"),
		orderUrl: text("order_url"),
		orderDate: date("order_date", { mode: "string" }),
		status: text("status", { enum: ORDER_STATUSES })
			.notNull()
			.default("unknown"),
		statusText: text("status_text"),
		placedByGroup: text("placed_by_group"),
		shipToAddress: text("ship_to_address"),
		checkoutEmailDomain: text("checkout_email_domain"),
		currency: text("currency"),
		subtotalMinor: money("subtotal_minor"),
		shippingMinor: money("shipping_minor"),
		taxMinor: money("tax_minor"),
		discountMinor: money("discount_minor"),
		totalMinor: money("total_minor"),
		paymentHint: text("payment_hint"),
		paymentMethodId: uuid("payment_method_id").references(
			() => paymentMethods.id,
			{ onDelete: "set null" },
		),
		entityId: uuid("entity_id").references(() => entities.id, {
			onDelete: "set null",
		}),
		categoryId: uuid("category_id").references(() => categories.id, {
			onDelete: "set null",
		}),
		/** Forced reimbursable flag; NULL = derive from payment method. */
		reimbursableOverride: boolean("reimbursable_override"),
		reviewState: text("review_state", { enum: REVIEW_STATES })
			.notNull()
			.default("inbox"),
		notes: text("notes"),
		tags: text("tags").array().notNull().default(sql`'{}'`),
		/** Denormalized item titles/SKUs for search. */
		itemsText: text("items_text"),
		/** Rule that last auto-assigned this order. */
		ruleId: uuid("rule_id"),
		firstSeenAt: ts("first_seen_at").defaultNow().notNull(),
		lastCapturedAt: ts("last_captured_at").defaultNow().notNull(),
		filedAt: ts("filed_at"),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("orders_owner_source_external_idx").on(
			t.ownerId,
			t.source,
			t.externalOrderId,
		),
		index("orders_owner_review_idx").on(t.ownerId, t.reviewState, t.orderDate),
		index("orders_owner_date_idx").on(t.ownerId, t.orderDate),
		index("orders_entity_idx").on(t.entityId),
		index("orders_search_vector_idx").using("gin", t.searchVector),
	],
);

export const orderItems = pgTable(
	"order_items",
	{
		/** Item-level full-text search ("where did I buy X"). */
		searchVector: tsvector("search_vector").generatedAlwaysAs(
			weightedSearchVector(
				sql`"title"`,
				sql`coalesce("sku", '') || ' ' || coalesce("variant", '')`,
			),
		),
		id: uuid("id").primaryKey().defaultRandom(),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		position: integer("position").notNull().default(0),
		externalItemId: text("external_item_id"),
		title: text("title").notNull(),
		sku: text("sku"),
		variant: text("variant"),
		quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" })
			.notNull()
			.default(1),
		unitPriceMinor: money("unit_price_minor"),
		totalMinor: money("total_minor"),
		imageUrl: text("image_url"),
		itemUrl: text("item_url"),
		entityId: uuid("entity_id").references(() => entities.id, {
			onDelete: "set null",
		}),
		categoryId: uuid("category_id").references(() => categories.id, {
			onDelete: "set null",
		}),
	},
	(t) => [
		index("order_items_order_idx").on(t.orderId, t.position),
		index("order_items_search_vector_idx").using("gin", t.searchVector),
	],
);

export const shipments = pgTable(
	"shipments",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		carrier: text("carrier"),
		trackingNumber: text("tracking_number").notNull(),
		status: text("status"),
		shippedAt: text("shipped_at"),
		deliveredAt: text("delivered_at"),
		etaText: text("eta_text"),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("shipments_order_tracking_idx").on(t.orderId, t.trackingNumber),
	],
);

export const orderCaptures = pgTable(
	"order_captures",
	{
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		captureId: uuid("capture_id")
			.notNull()
			.references(() => captures.id, { onDelete: "cascade" }),
		/** Latest successful parse emits this order. NULL = historical/unknown. */
		supportedByParser: boolean("supported_by_parser"),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.orderId, t.captureId] }),
		index("order_captures_capture_idx").on(t.captureId),
	],
);

export const DOCUMENT_KINDS = [
	"invoice",
	"receipt",
	"packing_slip",
	"order_page",
	"screenshot",
	"other",
] as const;

export const documents = pgTable(
	"documents",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		orderId: uuid("order_id").references(() => orders.id, {
			onDelete: "set null",
		}),
		source: text("source"),
		/** Store order id used to link the document once the order exists. */
		externalOrderId: text("external_order_id"),
		kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
		fileName: text("file_name").notNull(),
		contentType: text("content_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sha256: text("sha256").notNull(),
		storageKey: text("storage_key").notNull(),
		originUrl: text("origin_url"),
		captureId: uuid("capture_id"),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("documents_owner_sha_idx").on(t.ownerId, t.sha256),
		index("documents_order_idx").on(t.orderId),
		index("documents_pending_link_idx").on(
			t.ownerId,
			t.source,
			t.externalOrderId,
		),
	],
);

export const REIMBURSEMENT_STATUSES = [
	"none",
	"pending",
	"submitted",
	"reimbursed",
	"rejected",
] as const;
export type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

export const CLAIM_STATUSES = ["draft", "submitted", "paid", "void"] as const;

export const claims = pgTable(
	"claims",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		/** Entity that paid and is owed money. */
		payerEntityId: uuid("payer_entity_id")
			.notNull()
			.references(() => entities.id, { onDelete: "restrict" }),
		/** Entity that owes the reimbursement. */
		owingEntityId: uuid("owing_entity_id")
			.notNull()
			.references(() => entities.id, { onDelete: "restrict" }),
		status: text("status", { enum: CLAIM_STATUSES }).notNull().default("draft"),
		currency: text("currency").notNull(),
		totalMinor: money("total_minor").notNull().default(0),
		reference: text("reference"),
		notes: text("notes"),
		createdAt: ts("created_at").defaultNow().notNull(),
		submittedAt: ts("submitted_at"),
		paidAt: ts("paid_at"),
		/** Set when a claimed allocation's amount changed after the claim was made. */
		amountChangedAt: ts("amount_changed_at"),
	},
	(t) => [index("claims_owner_idx").on(t.ownerId, t.status)],
);

export const allocations = pgTable(
	"allocations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		entityId: uuid("entity_id")
			.notNull()
			.references(() => entities.id, { onDelete: "cascade" }),
		categoryId: uuid("category_id").references(() => categories.id, {
			onDelete: "set null",
		}),
		amountMinor: money("amount_minor").notNull(),
		currency: text("currency").notNull(),
		reimbursable: boolean("reimbursable").notNull().default(false),
		reimbursementStatus: text("reimbursement_status", {
			enum: REIMBURSEMENT_STATUSES,
		})
			.notNull()
			.default("none"),
		claimId: uuid("claim_id").references(() => claims.id, {
			onDelete: "set null",
		}),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		uniqueIndex("allocations_order_entity_idx").on(t.orderId, t.entityId),
		index("allocations_entity_idx").on(t.entityId, t.reimbursementStatus),
		index("allocations_claim_idx").on(t.claimId),
	],
);

export type RuleCondition = {
	field:
		| "source"
		| "merchant"
		| "item_title"
		| "sku"
		| "payment_last4"
		| "placed_by_group"
		| "ship_to_address"
		| "checkout_email_domain"
		| "total"
		| "currency";
	op: "equals" | "contains" | "matches" | "gt" | "lt";
	value: string;
};
export type RuleActions = {
	entityId?: string;
	categoryId?: string;
	reimbursable?: "auto" | "yes" | "no";
	file?: boolean;
	tags?: string[];
};

export const rules = pgTable(
	"rules",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		name: text("name").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		priority: integer("priority").notNull().default(100),
		match: text("match", { enum: ["all", "any"] })
			.notNull()
			.default("all"),
		conditions: jsonb("conditions").$type<RuleCondition[]>().notNull(),
		actions: jsonb("actions").$type<RuleActions>().notNull(),
		matchCount: integer("match_count").notNull().default(0),
		lastMatchedAt: ts("last_matched_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("rules_owner_priority_idx").on(t.ownerId, t.priority)],
);

export const CONNECTOR_PROVIDERS = ["custom_http", "invoice_ninja"] as const;
export type ConnectorProviderId = (typeof CONNECTOR_PROVIDERS)[number];

export const connections = pgTable(
	"connections",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		provider: text("provider", { enum: CONNECTOR_PROVIDERS }).notNull(),
		name: text("name").notNull(),
		/** The entity whose books this connection writes to. */
		entityId: uuid("entity_id")
			.notNull()
			.references(() => entities.id, { onDelete: "cascade" }),
		/** Non-secret settings + mappings (provider-specific, validated by provider). */
		config: jsonb("config").$type<Record<string, unknown>>().notNull(),
		secretCiphertext: text("secret_ciphertext"),
		enabled: boolean("enabled").notNull().default(true),
		status: text("status", { enum: ["untested", "ok", "error"] })
			.notNull()
			.default("untested"),
		lastCheckedAt: ts("last_checked_at"),
		lastError: text("last_error"),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [index("connections_owner_idx").on(t.ownerId)],
);

export const EXPORT_STATUSES = [
	"queued",
	"sending",
	"sent",
	"failed",
	"skipped",
	/** Sent, but the allocation amount changed afterwards: remote needs review. */
	"stale",
] as const;

export const exports = pgTable(
	"exports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		connectionId: uuid("connection_id")
			.notNull()
			.references(() => connections.id, { onDelete: "cascade" }),
		/** NULL once the allocation is gone (order re-assigned); history is kept. */
		allocationId: uuid("allocation_id").references(() => allocations.id, {
			onDelete: "set null",
		}),
		orderId: uuid("order_id").references(() => orders.id, {
			onDelete: "cascade",
		}),
		entityId: uuid("entity_id").references(() => entities.id, {
			onDelete: "set null",
		}),
		amountMinor: bigint("amount_minor", { mode: "number" }),
		status: text("status", { enum: EXPORT_STATUSES })
			.notNull()
			.default("queued"),
		remoteId: text("remote_id"),
		remoteUrl: text("remote_url"),
		error: text("error"),
		attempts: integer("attempts").notNull().default(0),
		createdAt: ts("created_at").defaultNow().notNull(),
		/** When the current push attempt began (stuck-push sweeper). */
		startedAt: ts("started_at"),
		sentAt: ts("sent_at"),
	},
	(t) => [
		uniqueIndex("exports_connection_allocation_idx").on(
			t.connectionId,
			t.allocationId,
		),
	],
);
