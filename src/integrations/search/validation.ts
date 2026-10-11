export class SearchError extends Error {
	constructor(public readonly code: "invalid-query" | "unavailable") {
		super(
			code === "invalid-query"
				? "Invalid search request"
				: "Search unavailable",
		);
		this.name = "SearchError";
	}
}
export function invalidSearch(): never {
	throw new SearchError("invalid-query");
}
export interface SearchCursor {
	rank: number;
	updatedAt: string;
	id: string;
}
export interface SearchInput {
	query: string;
	limit: number;
	cursor?: SearchCursor;
}
function validCursor(value: unknown): value is SearchCursor {
	if (!value || typeof value !== "object") return false;
	const { rank, updatedAt, id } = value as SearchCursor;
	if (
		typeof rank !== "number" ||
		!Number.isFinite(rank) ||
		rank < 0 ||
		rank > 1 ||
		Object.is(rank, -0) ||
		Math.fround(rank) !== rank
	)
		return false;
	// Validate the calendar without Date's millisecond truncation or year coercion.
	if (typeof updatedAt !== "string") return false;
	const parts =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(updatedAt);
	if (!parts) return false;
	const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (
		year < 1 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > days[month - 1] ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	)
		return false;
	return (
		typeof id === "string" &&
		id.length >= 1 &&
		id.length <= 128 &&
		!/\p{Cc}/u.test(id) &&
		Buffer.from(id, "utf8").toString("utf8") === id
	);
}
export function encodeSearchCursor(cursor: SearchCursor): string {
	if (!validCursor(cursor)) invalidSearch();
	const encoded = Buffer.from(
		JSON.stringify([1, cursor.rank, cursor.updatedAt, cursor.id]),
	).toString("base64url");
	if (encoded.length > 2048) invalidSearch();
	return encoded;
}
export function decodeSearchCursor(value: unknown): SearchCursor {
	if (
		typeof value !== "string" ||
		value.length > 2048 ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	)
		invalidSearch();
	try {
		const tuple: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.from(value, "base64url"),
			),
		);
		if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== 1)
			invalidSearch();
		const cursor = { rank: tuple[1], updatedAt: tuple[2], id: tuple[3] };
		if (!validCursor(cursor) || encodeSearchCursor(cursor) !== value)
			invalidSearch();
		return cursor;
	} catch {
		return invalidSearch();
	}
}
export function parseSearchInput(value: unknown): SearchInput {
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalidSearch();
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) => !["query", "limit", "cursor"].includes(key),
		)
	)
		invalidSearch();
	if (typeof input.query !== "string") invalidSearch();
	const query = input.query.trim();
	if (
		query.length < 2 ||
		query.length > 256 ||
		Buffer.from(query, "utf8").toString("utf8") !== query ||
		query.includes("\0")
	)
		invalidSearch();
	const limit = input.limit === undefined ? 25 : input.limit;
	if (
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		invalidSearch();
	return {
		query,
		limit,
		...(input.cursor === undefined
			? {}
			: { cursor: decodeSearchCursor(input.cursor) }),
	};
}
export interface SearchRequest {
	query: string;
	limit?: number;
	cursor?: string;
}
