import {
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import type { NotificationJson } from "./validation";
export const notifications = pgTable(
	"notification",
	{
		id: uuid("id").primaryKey(),
		recipientId: varchar("recipient_id", { length: 128 }).notNull(),
		type: varchar("type", { length: 128 }).notNull(),
		title: varchar("title", { length: 200 }).notNull(),
		body: text("body").notNull(),
		metadata: jsonb("metadata")
			.$type<{ [key: string]: NotificationJson }>()
			.default({})
			.notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			precision: 3,
			mode: "date",
		}).notNull(),
		readAt: timestamp("read_at", {
			withTimezone: true,
			precision: 3,
			mode: "date",
		}),
	},
	(t) => [
		index("notification_recipient_time_idx").on(
			t.recipientId,
			t.createdAt.desc(),
			t.id.desc(),
		),
		index("notification_recipient_read_idx").on(
			t.recipientId,
			t.readAt,
			t.createdAt.desc(),
			t.id.desc(),
		),
		index("notification_recipient_type_idx").on(
			t.recipientId,
			t.type,
			t.createdAt.desc(),
			t.id.desc(),
		),
	],
);
export type Notification = typeof notifications.$inferSelect;
