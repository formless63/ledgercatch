import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
export const flagDefinitions = pgTable(
	"feature_flag",
	{
		key: text("key").primaryKey(),
		description: text("description").notNull(),
		enabled: boolean("enabled").notNull().default(false),
		defaultValue: boolean("default_value").notNull().default(false),
		rolloutBasisPoints: integer("rollout_basis_points"),
		revision: integer("revision").notNull().default(1),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
	},
	(t) => [
		check("feature_flag_revision", sql`${t.revision}>0`),
		check(
			"feature_flag_rollout",
			sql`${t.rolloutBasisPoints} IS NULL OR ${t.rolloutBasisPoints} BETWEEN 0 AND 10000`,
		),
		index("feature_flag_created").on(t.createdAt, t.key),
	],
);
export const flagOverrides = pgTable(
	"feature_flag_override",
	{
		id: uuid("id").primaryKey(),
		flagKey: text("flag_key")
			.notNull()
			.references(() => flagDefinitions.key),
		targetKind: text("target_kind").notNull(),
		targetId: text("target_id").notNull(),
		value: boolean("value").notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			precision: 3,
		}).notNull(),
	},
	(t) => [
		check(
			"feature_flag_override_kind",
			sql`${t.targetKind} IN ('user','tenant')`,
		),
		uniqueIndex("feature_flag_override_target").on(
			t.flagKey,
			t.targetKind,
			t.targetId,
		),
		index("feature_flag_override_created").on(t.flagKey, t.createdAt, t.id),
	],
);
