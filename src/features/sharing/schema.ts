/**
 * Read-only entity sharing (docs/IDEAS.md #18, interim design).
 *
 * An owner grants one email address read-only ("viewer") access to ONE entity.
 * The grantee signs in with their own account (magic link / OAuth) and accepts
 * the invite with a single-use token; from then on access is bound to
 * `accepted_user_id`, not to the email. Revoking sets `revoked_at`.
 */
import { sql } from "drizzle-orm";
import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { user } from "../../db/schema";
import { entities } from "../ledger/schema";

const ts = (name: string) =>
	timestamp(name, { mode: "date", withTimezone: true });

export const SHARE_ROLES = ["viewer"] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const entityShares = pgTable(
	"entity_shares",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		entityId: uuid("entity_id")
			.notNull()
			.references(() => entities.id, { onDelete: "cascade" }),
		/** Lower-cased, trimmed. */
		granteeEmail: text("grantee_email").notNull(),
		role: text("role", { enum: SHARE_ROLES }).notNull().default("viewer"),
		/** sha256(hex) of the single-use invite token; NULL once accepted. */
		tokenHash: text("token_hash"),
		tokenExpiresAt: ts("token_expires_at"),
		acceptedUserId: text("accepted_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		acceptedAt: ts("accepted_at"),
		lastAccessedAt: ts("last_accessed_at"),
		createdAt: ts("created_at").defaultNow().notNull(),
		revokedAt: ts("revoked_at"),
	},
	(t) => [
		index("entity_shares_owner_idx").on(t.ownerId, t.entityId),
		index("entity_shares_grantee_idx").on(t.acceptedUserId),
		index("entity_shares_email_idx").on(t.granteeEmail),
		uniqueIndex("entity_shares_token_idx").on(t.tokenHash),
		// One live share per (entity, email); revoked rows are history.
		uniqueIndex("entity_shares_active_idx")
			.on(t.entityId, t.granteeEmail)
			.where(sql`${t.revokedAt} is null`),
	],
);

export type EntityShareRow = typeof entityShares.$inferSelect;
