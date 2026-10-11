import assert from "node:assert/strict";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import pg from "pg";
import {
	weightedSearchVector,
	tsvector,
} from "../src/integrations/search/schema";
import {
	safeSearch,
	searchAfter,
	searchPage,
	searchQuery,
	searchRank,
	searchTimestamp,
} from "../src/integrations/search/search.server";
import {
	decodeSearchCursor,
	encodeSearchCursor,
	parseSearchInput,
	SearchError,
	type SearchRequest,
} from "../src/integrations/search/validation";

assert.ok(
	process.env.DATABASE_URL,
	"Select a non-production PostgreSQL 18 test database",
);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
// Disposable test schema only. Search installs no application-owned table.
const fixture = pgTable("search_fixture", {
	id: text("id").primaryKey(),
	owner: text("owner").notNull(),
	title: text("title").notNull(),
	body: text("body"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	vector: tsvector("vector").generatedAlwaysAs(
		weightedSearchVector(sql`title`, sql`body`),
	),
});
const marker = "privateSearchMarker";
const captured: unknown[] = [];
const methods = ["log", "info", "warn", "error", "debug"] as const;
const originals = methods.map((method) => console[method]);
try {
	const version = await pool.query("SHOW server_version_num");
	assert.equal(
		Math.floor(Number(version.rows[0].server_version_num) / 10000),
		18,
	);
	for (const [index, method] of methods.entries())
		console[method] = (...args: unknown[]) => {
			captured.push(args);
			originals[index](...args);
		};
	await db.transaction(async (tx) => {
		await tx.execute(
			sql`CREATE TEMP TABLE search_fixture (id text PRIMARY KEY, owner text NOT NULL, title text NOT NULL, body text, updated_at timestamptz NOT NULL, vector tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED) ON COMMIT DROP`,
		);
		await tx.execute(
			sql`CREATE INDEX search_fixture_vector_idx ON search_fixture USING gin (vector)`,
		);
		await tx.execute(sql`SET LOCAL default_text_search_config = 'english'`);
		async function search(request: SearchRequest, owner = "a") {
			const input = parseSearchInput(request);
			const query = searchQuery(input.query);
			const rank = searchRank(fixture.vector, query);
			return safeSearch(async () =>
				searchPage(
					await tx
						.select({
							row: { id: fixture.id, title: fixture.title },
							id: fixture.id,
							rankText: sql<string>`${rank}::text`,
							updatedAtText: searchTimestamp(fixture.updatedAt),
						})
						.from(fixture)
						.where(
							and(
								eq(fixture.owner, owner),
								sql`${fixture.vector} @@ ${query}`,
								searchAfter(rank, fixture.updatedAt, fixture.id, input.cursor),
							),
						)
						.orderBy(desc(rank), desc(fixture.updatedAt), desc(fixture.id))
						.limit(input.limit + 1),
					input.limit,
				),
			);
		}
		await tx.insert(fixture).values([
			{
				id: "a-title",
				owner: "a",
				title: "orbit",
				body: "",
				updatedAt: new Date("2026-01-01"),
			},
			{
				id: "b-body",
				owner: "a",
				title: "",
				body: "orbit",
				updatedAt: new Date("2026-01-01"),
			},
			{
				id: "foreign",
				owner: "b",
				title: "orbit",
				body: marker,
				updatedAt: new Date("2026-01-01"),
			},
			{
				id: "phrase",
				owner: "a",
				title: "solar wind",
				body: "",
				updatedAt: new Date("2026-01-01"),
			},
			{
				id: "separate",
				owner: "a",
				title: "solar bright wind",
				body: "",
				updatedAt: new Date("2026-01-01"),
			},
			{
				id: "simple",
				owner: "a",
				title: "running",
				body: null,
				updatedAt: new Date("2026-01-01"),
			},
			...Array.from({ length: 137 }, (_, i) => ({
				id: `tie-${String(i).padStart(3, "0")}`,
				owner: "a",
				title: "",
				body: "tie",
				updatedAt: new Date("2026-01-01"),
			})),
		]);
		const weighted = await search({ query: "orbit" });
		assert.deepEqual(
			weighted.results.map((r) => r.row.id),
			["a-title", "b-body"],
		);
		assert.ok(weighted.results[0].rank > weighted.results[1].rank);
		assert.equal(weighted.nextCursor, null);
		assert.equal((await search({ query: "orbit" }, "b")).results.length, 1);
		assert.equal((await search({ query: "solar wind" })).results.length, 2);
		assert.deepEqual(
			(await search({ query: '"solar wind"' })).results.map((r) => r.row.id),
			["phrase"],
		);
		assert.equal((await search({ query: "orbit OR solar" })).results.length, 4);
		assert.equal((await search({ query: "solar -bright" })).results.length, 1);
		assert.equal((await search({ query: "run" })).results.length, 0); // explicit simple, no stemming/session default
		assert.equal((await search({ query: "running" })).results.length, 1);
		for (const query of [
			"ab",
			"x".repeat(256),
			"  orbit  ",
			"orbit:* | !solar",
			"'; DROP TABLE search_fixture; --",
			marker,
			"!!!",
		])
			await search({ query });
		assert.equal(parseSearchInput({ query: "  ab  " }).query, "ab");
		assert.equal(parseSearchInput({ query: "ab" }).limit, 25);
		for (const request of [
			{ query: "a" },
			{ query: "x".repeat(257) },
			{ query: "   " },
			{ query: 1 },
			{ query: "orbit", limit: 0 },
			{ query: "orbit", limit: 101 },
			{ query: "orbit", limit: 1.5 },
			{ query: "orbit", filter: "SQL" },
			{ query: "orbit", cursor: "!" },
		])
			assert.throws(
				() => parseSearchInput(request),
				(e: unknown) => e instanceof SearchError && e.code === "invalid-query",
			);
		assert.equal((await search({ query: "tie" })).results.length, 25);
		assert.equal(
			(await search({ query: "tie", limit: 100 })).results.length,
			100,
		);
		// PostgreSQL timestamps can distinguish rows within the same JS millisecond.
		await tx.execute(
			sql`UPDATE search_fixture SET updated_at = '2026-01-01T00:00:00.000123Z' WHERE id = 'tie-000'`,
		);
		const reference = await tx.execute(
			sql`SELECT id FROM search_fixture WHERE owner = 'a' AND vector @@ websearch_to_tsquery('simple', 'tie') ORDER BY ts_rank_cd(vector, websearch_to_tsquery('simple', 'tie'), 32) DESC, updated_at DESC, id DESC`,
		);
		for (const limit of [1, undefined, 100]) {
			const ids: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await search({
					query: "tie",
					...(limit ? { limit } : {}),
					...(cursor ? { cursor } : {}),
				});
				ids.push(...page.results.map((r) => r.row.id));
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			assert.deepEqual(
				ids,
				reference.rows.map((r) => r.id),
			);
			assert.equal(new Set(ids).size, 137);
			assert.equal(ids[0], "tie-000");
			assert.equal(ids[1], "tie-136");
			assert.equal(ids.at(-1), "tie-001");
		}
		const first = await search({ query: "tie", limit: 1 });
		assert.ok(first.nextCursor);
		const decoded = decodeSearchCursor(first.nextCursor);
		const storedRank = await tx.execute(
			sql`SELECT ts_rank_cd(vector, websearch_to_tsquery('simple', 'tie'), 32)::text AS rank FROM search_fixture WHERE id = 'tie-000'`,
		);
		assert.equal(decoded.rank, Math.fround(Number(storedRank.rows[0].rank)));
		assert.equal(first.results[0].rank, decoded.rank);
		const rebound = await tx.execute(
			sql`SELECT ${JSON.parse(JSON.stringify(decoded.rank))}::real::double precision AS rank`,
		);
		assert.equal(rebound.rows[0].rank, decoded.rank);
		assert.notEqual(decoded.rank, 0.5); // pagination exercises a non-binary-exact B-weight rank
		assert.equal(decoded.updatedAt, "2026-01-01T00:00:00.000123Z");
		assert.equal(encodeSearchCursor(decoded), first.nextCursor);
		const asCursor = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		for (const bad of [
			first.nextCursor + "=",
			first.nextCursor + "A",
			"a".repeat(2049),
			asCursor([2, decoded.rank, decoded.updatedAt, decoded.id]),
			asCursor([1, 0.2857143, decoded.updatedAt, decoded.id]),
			asCursor([1, "0.50", decoded.updatedAt, decoded.id]),
			asCursor([1, "NaN", decoded.updatedAt, decoded.id]),
			asCursor([1, "1e-999", decoded.updatedAt, decoded.id]),
			asCursor([1, "1e-46", decoded.updatedAt, decoded.id]),
			asCursor([1, "0.5", "2026-02-30T00:00:00.000000Z", decoded.id]),
			asCursor([1, "0.5", decoded.updatedAt, ""]),
			Buffer.from(
				JSON.stringify(
					[1, decoded.rank, decoded.updatedAt, decoded.id],
					null,
					2,
				),
			).toString("base64url"),
		])
			assert.throws(() => decodeSearchCursor(bad), SearchError);
		await tx
			.update(fixture)
			.set({ title: "changed" })
			.where(eq(fixture.id, "a-title"));
		assert.equal((await search({ query: "orbit" })).results.length, 1); // generated vector follows UPDATE without trigger
	});
	await assert.rejects(
		safeSearch(async () => {
			await db.execute(sql`SELECT * FROM search_intentionally_missing_fixture`);
		}),
		(e: unknown) =>
			e instanceof SearchError &&
			e.code === "unavailable" &&
			!JSON.stringify(e).includes(marker) &&
			!("cause" in e),
	);
	assert.ok(!JSON.stringify(captured).includes(marker));
} finally {
	for (const [index, method] of methods.entries())
		console[method] = originals[index];
	await pool.end();
}
console.info(
	"Search PostgreSQL 18 safety, weights, websearch, owner predicates and exact keyset contract passed",
);
