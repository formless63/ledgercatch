import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";

type FileState = "uploading" | "ready" | "cleanup-pending" | "removed";
/** Root-owned durable adapter schema, retained with migration/data on application removal. */
export const fileUiFiles = pgTable(
	"file_ui_files",
	{
		id: text("id").primaryKey(),
		owner: text("owner").notNull(),
		key: text("object_key").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		digest: text("digest").notNull(),
		fingerprint: text("fingerprint").notNull(),
		name: text("name").notNull(),
		type: text("type").notNull(),
		size: integer("size").notNull(),
		state: text("state").$type<FileState>().notNull(),
		revision: integer("revision").notNull(),
		writerStopped: boolean("writer_stopped").notNull(),
		createdAt: bigint("created_at", { mode: "number" }).notNull(),
	},
	(table) => [
		uniqueIndex("file_ui_owner_token").on(table.owner, table.idempotencyKey),
		uniqueIndex("file_ui_object_key").on(table.key),
		index("file_ui_owner_created").on(table.owner, table.createdAt),
	],
);
