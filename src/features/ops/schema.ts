/**
 * Pipeline maintenance state: per-user capture retention settings and the
 * auto-reparse cursor per parser. Register these in src/db/schema.ts (export)
 * so drizzle-kit generates the migration.
 */
import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });

/**
 * Per-user override of the env defaults (CAPTURE_RETENTION_DAYS,
 * CAPTURE_COMPACT_MIN_BYTES, CAPTURE_COMPACTION). NULL columns fall back to
 * the env value. Compaction never deletes a capture; it only moves large raw
 * bodies to object storage.
 */
export const captureRetentionSettings = pgTable("capture_retention_settings", {
	ownerId: text("owner_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	/** false = never compact this user's captures. */
	compactionEnabled: boolean("compaction_enabled").notNull().default(true),
	/** Keep raw bodies in Postgres for this many days after receipt. */
	keepRawDays: integer("keep_raw_days"),
	/** Only bodies larger than this many bytes are moved. */
	compactMinBytes: integer("compact_min_bytes"),
	updatedAt: ts("updated_at").defaultNow().notNull(),
});

/**
 * Auto-reparse progress, one row per registry parser. When the registry
 * version differs from `targetVersion` the cursor restarts; each capture is
 * requeued at most once per (parser, version), so a parser that keeps
 * throwing cannot make the scheduler loop.
 */
export const parserReparseProgress = pgTable("parser_reparse_progress", {
	parserId: text("parser_id").primaryKey(),
	targetVersion: integer("target_version").notNull(),
	/** Last requeued capture (received_at truncated to ms, id) — keyset cursor. */
	cursorReceivedAt: ts("cursor_received_at"),
	cursorId: uuid("cursor_id"),
	requeued: integer("requeued").notNull().default(0),
	startedAt: ts("started_at").defaultNow().notNull(),
	completedAt: ts("completed_at"),
	updatedAt: ts("updated_at").defaultNow().notNull(),
});
