import { type SQLWrapper, sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

// Schema-only helper: retain with domain schema when removing runtime Search.
export const tsvector = customType<{ data: string }>({
	dataType: () => "tsvector",
});
export function weightedSearchVector(title: SQLWrapper, body: SQLWrapper) {
	return sql`setweight(to_tsvector('simple', coalesce(${title}, '')), 'A') || setweight(to_tsvector('simple', coalesce(${body}, '')), 'B')`;
}
