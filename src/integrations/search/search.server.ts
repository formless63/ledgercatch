import { type SQLWrapper, sql } from "drizzle-orm";
import {
	encodeSearchCursor,
	type SearchCursor,
	SearchError,
} from "./validation";

// SQL helpers compose with application-owned columns/predicates, never table names from a client.
export function searchQuery(query: string) {
	return sql`websearch_to_tsquery('simple', ${query})`;
}
export function searchRank(vector: SQLWrapper, query: SQLWrapper) {
	return sql`ts_rank_cd(${vector}, ${query}, 32)`;
}
export function searchTimestamp(timestamp: SQLWrapper) {
	return sql<string>`to_char(${timestamp} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
export function searchAfter(
	rank: SQLWrapper,
	timestamp: SQLWrapper,
	id: SQLWrapper,
	cursor?: SearchCursor,
) {
	return cursor
		? sql`(${rank}, ${timestamp}, ${id}) < (${cursor.rank}::real, ${cursor.updatedAt}::timestamptz, ${cursor.id})`
		: undefined;
}
export function searchPage<T>(
	rows: { row: T; rankText: string; updatedAtText: string; id: string }[],
	limit: number,
) {
	const selected = rows.slice(0, limit);
	const last = selected.at(-1);
	return {
		results: selected.map(({ row, rankText }) => ({
			row,
			rank: Math.fround(Number(rankText)),
		})),
		nextCursor:
			rows.length > limit && last
				? encodeSearchCursor({
						rank: Math.fround(Number(last.rankText)),
						updatedAt: last.updatedAtText,
						id: last.id,
					})
				: null,
	};
}
export async function safeSearch<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch {
		throw new SearchError("unavailable");
	}
}
