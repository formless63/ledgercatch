/**
 * Order lifecycle tables: refunds, assets, duplicate dismissals, extra
 * document links and shipment tracking state. Registered from
 * src/db/schema.ts alongside the ledger schema.
 *
 * Search note (#5): item-level FTS wants a generated column on
 * `order_items`, which belongs to the ledger schema:
 *
 *   searchVector: tsvector("search_vector").generatedAlwaysAs(
 *     weightedSearchVector(
 *       sql`"title"`,
 *       sql`coalesce("sku", '') || ' ' || coalesce("variant", '')`,
 *     ),
 *   ),
 *   index("order_items_search_vector_idx").using("gin", t.searchVector)
 *
 * Until it exists, item search uses ILIKE (see items.server.ts).
 */
import {
	bigint,
	date,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";
import {
	captures,
	documents,
	entities,
	orderItems,
	orders,
	shipments,
} from "../ledger/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });
const owner = () =>
	text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" });

/* ───────────────────────── refunds (#10) ───────────────────────── */

export const REFUND_STATUSES = ["requested", "approved", "refunded"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const refunds = pgTable(
	"refunds",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		/** Refund of one line; NULL = order-level (spread across allocations). */
		orderItemId: uuid("order_item_id").references(() => orderItems.id, {
			onDelete: "set null",
		}),
		amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
		currency: text("currency").notNull(),
		reason: text("reason"),
		status: text("status", { enum: REFUND_STATUSES })
			.notNull()
			.default("requested"),
		/** ISO date the money came back. */
		refundedAt: date("refunded_at", { mode: "string" }),
		/** manual | parser | email | import */
		origin: text("origin").notNull().default("manual"),
		/** Store refund / reverse-order id; parser idempotency key. */
		externalRefundId: text("external_refund_id"),
		captureId: uuid("capture_id").references(() => captures.id, {
			onDelete: "set null",
		}),
		documentId: uuid("document_id").references(() => documents.id, {
			onDelete: "set null",
		}),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("refunds_order_idx").on(t.orderId),
		index("refunds_owner_idx").on(t.ownerId, t.status),
		uniqueIndex("refunds_order_external_idx").on(t.orderId, t.externalRefundId),
	],
);

/* ───────────────────────── assets (#13) ───────────────────────── */

export const ASSET_STATUSES = ["in_service", "retired", "sold"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const assets = pgTable(
	"assets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: owner(),
		orderId: uuid("order_id").references(() => orders.id, {
			onDelete: "set null",
		}),
		orderItemId: uuid("order_item_id").references(() => orderItems.id, {
			onDelete: "set null",
		}),
		entityId: uuid("entity_id").references(() => entities.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		serial: text("serial"),
		purchaseDate: date("purchase_date", { mode: "string" }),
		warrantyMonths: integer("warranty_months"),
		/** Explicit or derived from purchase date + warranty months. */
		warrantyExpiresAt: date("warranty_expires_at", { mode: "string" }),
		location: text("location"),
		notes: text("notes"),
		status: text("status", { enum: ASSET_STATUSES })
			.notNull()
			.default("in_service"),
		createdAt: ts("created_at").defaultNow().notNull(),
		updatedAt: ts("updated_at").defaultNow().notNull(),
	},
	(t) => [
		index("assets_owner_idx").on(t.ownerId, t.status),
		index("assets_owner_warranty_idx").on(t.ownerId, t.warrantyExpiresAt),
		index("assets_order_item_idx").on(t.orderItemId),
	],
);

export const assetDocuments = pgTable(
	"asset_documents",
	{
		assetId: uuid("asset_id")
			.notNull()
			.references(() => assets.id, { onDelete: "cascade" }),
		documentId: uuid("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.assetId, t.documentId] }),
		index("asset_documents_document_idx").on(t.documentId),
	],
);

/* ──────────────────── duplicate dismissals (#6) ──────────────────── */

/** "Not a duplicate" decisions. Pair stored canonically: order_a_id < order_b_id. */
export const orderDuplicateDismissals = pgTable(
	"order_duplicate_dismissals",
	{
		ownerId: owner(),
		orderAId: uuid("order_a_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		orderBId: uuid("order_b_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.orderAId, t.orderBId] }),
		index("order_duplicate_dismissals_b_idx").on(t.orderBId),
	],
);

/* ──────────────────── document links (risk 9) ──────────────────── */

/**
 * Additional order links for one document (combined invoices).
 * `documents.order_id` stays the primary link; rows here are extra.
 */
export const documentLinks = pgTable(
	"document_links",
	{
		documentId: uuid("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		orderId: uuid("order_id")
			.notNull()
			.references(() => orders.id, { onDelete: "cascade" }),
		createdAt: ts("created_at").defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.documentId, t.orderId] }),
		index("document_links_order_idx").on(t.orderId),
	],
);

/* ──────────────────── shipment tracking (#21) ──────────────────── */

export const shipmentTracking = pgTable(
	"shipment_tracking",
	{
		shipmentId: uuid("shipment_id")
			.primaryKey()
			.references(() => shipments.id, { onDelete: "cascade" }),
		provider: text("provider").notNull(),
		/** Provider accepted the number (registration is a separate call for some). */
		registeredAt: ts("registered_at"),
		lastCheckedAt: ts("last_checked_at"),
		lastStatus: text("last_status"),
		lastEventAt: text("last_event_at"),
		lastEventText: text("last_event_text"),
		error: text("error"),
		attempts: integer("attempts").notNull().default(0),
	},
	(t) => [index("shipment_tracking_checked_idx").on(t.lastCheckedAt)],
);
