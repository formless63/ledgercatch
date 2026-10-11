import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import type { DraftInput } from "./validation";

const time = (name: string) =>
	timestamp(name, { withTimezone: true, precision: 3, mode: "date" });
export type OperationKind =
	| "create_draft"
	| "reconcile_client"
	| "reconcile_invoice";
export type OperationStatus =
	| "queued"
	| "dispatching"
	| "succeeded"
	| "failed"
	| "reconciliation_required"
	| "cancelled";
export type InvoiceStatus =
	| "draft"
	| "sent"
	| "partial"
	| "paid"
	| "cancelled"
	| "reversed"
	| "deleted"
	| "unknown";
export type DraftPolicy = {
	currencyId: string;
	currency: string;
	configurationIdentity: string;
	verifiedPin: "382020072bc79e8c7ede49f7e9ce91b0aeb1a051";
	numericStrings: true;
	unsent: true;
	zeroTax: true;
	zeroDiscount: true;
};
export type FrozenDraft = {
	input: DraftInput;
	policy: DraftPolicy;
	clientRemoteId: string;
};
export const bindings = pgTable(
	"invoice_ninja_binding",
	{
		id: uuid("id").primaryKey(),
		scopeKind: varchar("scope_kind", { length: 6 })
			.$type<"user" | "tenant">()
			.notNull(),
		scopeId: varchar("scope_id", { length: 128 }).notNull(),
		localResourceId: varchar("local_resource_id", { length: 128 }).notNull(),
		connectionId: varchar("connection_id", { length: 64 }).notNull(),
		resourceKind: varchar("resource_kind", { length: 7 })
			.$type<"client" | "invoice">()
			.notNull(),
		remoteId: varchar("remote_id", { length: 128 }).notNull(),
		createdAt: time("created_at").notNull(),
		retiredAt: time("retired_at"),
		revision: integer("revision").notNull().default(0),
		leaseToken: uuid("lease_token"),
		leaseUntil: time("lease_until"),
	},
	(t) => [
		uniqueIndex("invoice_ninja_binding_local").on(
			t.scopeKind,
			t.scopeId,
			t.resourceKind,
			t.localResourceId,
		),
		uniqueIndex("invoice_ninja_binding_remote").on(
			t.connectionId,
			t.resourceKind,
			t.remoteId,
		),
		check(
			"invoice_ninja_binding_scope",
			sql`${t.scopeKind} in ('user','tenant')`,
		),
		check(
			"invoice_ninja_binding_kind",
			sql`${t.resourceKind} in ('client','invoice')`,
		),
	],
);
export type Binding = typeof bindings.$inferSelect;
export const clients = pgTable("invoice_ninja_client", {
	bindingId: uuid("binding_id")
		.primaryKey()
		.references(() => bindings.id),
	syncedAt: time("synced_at").notNull(),
});
export const invoices = pgTable(
	"invoice_ninja_invoice",
	{
		bindingId: uuid("binding_id")
			.primaryKey()
			.references(() => bindings.id),
		number: varchar("number", { length: 128 }),
		status: varchar("status", { length: 12 }).$type<InvoiceStatus>().notNull(),
		currency: varchar("currency", { length: 3 }),
		amount: varchar("amount", { length: 35 }),
		balance: varchar("balance", { length: 35 }),
		sourceUpdatedAt: time("source_updated_at"),
		syncedAt: time("synced_at").notNull(),
		deleted: boolean("deleted").notNull().default(false),
	},
	(t) => [
		check(
			"invoice_ninja_invoice_status",
			sql`${t.status} in ('draft','sent','partial','paid','cancelled','reversed','deleted','unknown')`,
		),
	],
);
export const operations = pgTable(
	"invoice_ninja_operation",
	{
		id: uuid("id").primaryKey(),
		scopeKind: varchar("scope_kind", { length: 6 })
			.$type<"user" | "tenant">()
			.notNull(),
		scopeId: varchar("scope_id", { length: 128 }).notNull(),
		actorUserId: varchar("actor_user_id", { length: 128 }).notNull(),
		connectionId: varchar("connection_id", { length: 64 }).notNull(),
		kind: varchar("kind", { length: 24 }).$type<OperationKind>().notNull(),
		status: varchar("status", { length: 24 })
			.$type<OperationStatus>()
			.notNull(),
		bindingId: uuid("binding_id").references(() => bindings.id),
		callerKey: varchar("caller_key", { length: 128 }).notNull(),
		digest: varchar("digest", { length: 64 }).notNull(),
		intent: jsonb("intent").$type<FrozenDraft>(),
		remoteId: varchar("remote_id", { length: 128 }),
		createdAt: time("created_at").notNull(),
		updatedAt: time("updated_at").notNull(),
		firstDispatchAt: time("first_dispatch_at"),
		leaseToken: uuid("lease_token"),
		leaseUntil: time("lease_until"),
		revision: integer("revision").notNull().default(0),
		errorCode: varchar("error_code", { length: 24 }),
	},
	(t) => [
		uniqueIndex("invoice_ninja_operation_key").on(
			t.scopeKind,
			t.scopeId,
			t.connectionId,
			t.kind,
			t.callerKey,
		),
		index("invoice_ninja_operation_recovery").on(t.status, t.leaseUntil),
		check(
			"invoice_ninja_operation_status",
			sql`${t.status} in ('queued','dispatching','succeeded','failed','reconciliation_required','cancelled')`,
		),
		check(
			"invoice_ninja_operation_kind",
			sql`${t.kind} in ('create_draft','reconcile_client','reconcile_invoice')`,
		),
	],
);
export const inbox = pgTable(
	"invoice_ninja_inbox",
	{
		id: uuid("id").primaryKey(),
		connectionId: varchar("connection_id", { length: 64 }).notNull(),
		eventKind: varchar("event_kind", { length: 24 }).notNull(),
		bodySHA256: varchar("body_sha256", { length: 64 }).notNull(),
		remoteHint: varchar("remote_hint", { length: 128 }).notNull(),
		bindingId: uuid("binding_id").references(() => bindings.id),
		state: varchar("state", { length: 12 })
			.$type<"received" | "processing" | "processed" | "ignored" | "failed">()
			.notNull(),
		receivedAt: time("received_at").notNull(),
		updatedAt: time("updated_at").notNull(),
		revision: integer("revision").notNull().default(0),
		leaseToken: uuid("lease_token"),
		leaseUntil: time("lease_until"),
		errorCode: varchar("error_code", { length: 24 }),
	},
	(t) => [
		uniqueIndex("invoice_ninja_receipt_identity").on(
			t.connectionId,
			t.eventKind,
			t.bodySHA256,
		),
		check(
			"invoice_ninja_inbox_state",
			sql`${t.state} in ('received','processing','processed','ignored','failed')`,
		),
	],
);
