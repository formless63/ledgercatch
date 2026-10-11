import {
	index,
	jsonb,
	pgTable,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export type AuditJson =
	| null
	| boolean
	| number
	| string
	| AuditJson[]
	| { [key: string]: AuditJson };

// Kept as schema source during application removal to preserve migration history.
export const auditEvents = pgTable(
	"audit_event",
	{
		id: uuid("id").primaryKey(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
			precision: 3,
		})
			.defaultNow()
			.notNull(),
		actorType: varchar("actor_type", { length: 64 }).notNull(),
		actorId: varchar("actor_id", { length: 256 }),
		action: varchar("action", { length: 128 }).notNull(),
		subjectType: varchar("subject_type", { length: 64 }).notNull(),
		subjectId: varchar("subject_id", { length: 256 }),
		outcome: varchar("outcome", { length: 64 }),
		requestId: varchar("request_id", { length: 128 }),
		metadata: jsonb("metadata")
			.$type<{ [key: string]: AuditJson }>()
			.default({})
			.notNull(),
	},
	(table) => [
		index("audit_event_time_idx").on(table.createdAt.desc(), table.id.desc()),
		index("audit_event_actor_idx").on(
			table.actorType,
			table.actorId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		index("audit_event_subject_idx").on(
			table.subjectType,
			table.subjectId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		index("audit_event_action_idx").on(
			table.action,
			table.createdAt.desc(),
			table.id.desc(),
		),
	],
);
