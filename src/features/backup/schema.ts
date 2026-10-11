/** "Export everything" archives (docs/IDEAS.md #20). */
import {
	bigint,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });

export const EXPORT_ARCHIVE_STATUSES = [
	"queued",
	"running",
	"ready",
	"failed",
	"expired",
] as const;
export type ExportArchiveStatus = (typeof EXPORT_ARCHIVE_STATUSES)[number];

export type ExportArchiveSummary = {
	formatVersion: number;
	generatedAt: string;
	counts: { [table: string]: number };
	documents: number;
	skippedDocuments: number;
};

export const exportArchives = pgTable(
	"export_archives",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		status: text("status", { enum: EXPORT_ARCHIVE_STATUSES })
			.notNull()
			.default("queued"),
		storageKey: text("storage_key"),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		documentCount: integer("document_count").notNull().default(0),
		/** Per-table row counts and skipped documents (manifest summary). */
		summary: jsonb("summary").$type<ExportArchiveSummary>(),
		error: text("error"),
		createdAt: ts("created_at").defaultNow().notNull(),
		startedAt: ts("started_at"),
		completedAt: ts("completed_at"),
		expiresAt: ts("expires_at"),
	},
	(t) => [index("export_archives_owner_idx").on(t.ownerId, t.createdAt)],
);

export type ExportArchiveRow = typeof exportArchives.$inferSelect;
