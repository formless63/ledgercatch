import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { expect, it } from "vitest";

it("creates the generated Orders search vector and GIN index from the migration history", async () => {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("Disposable PostgreSQL admin URL required");
	const admin = new pg.Pool({ connectionString: url });
	const name = `search_${randomUUID().replaceAll("-", "")}`;
	const target = new URL(url);
	target.pathname = `/${name}`;
	const pool = new pg.Pool({ connectionString: target.toString() });
	try {
		await admin.query(`CREATE DATABASE "${name}"`);
		await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
		const journal = JSON.parse(
			await readFile("drizzle/meta/_journal.json", "utf8"),
		);
		const history = await pool.query(
			"SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id",
		);
		expect(history.rows).toHaveLength(journal.entries.length);
		await pool.query(
			`INSERT INTO "user" (id, name, email) VALUES ('before', 'Before', 'before@example.test'); INSERT INTO orders (id, owner_id, source, external_order_id, merchant_name) VALUES ('00000000-0000-4000-8000-000000000001', 'before', 'generic', 'N-1', 'Existing nebula')`,
		);
		expect(
			(
				await pool.query(
					"SELECT id::text FROM orders WHERE search_vector @@ websearch_to_tsquery('simple', 'nebula')",
				)
			).rows,
		).toEqual([{ id: "00000000-0000-4000-8000-000000000001" }]);
		// Re-running is a no-op that preserves applied history.
		await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
		expect(
			(
				await pool.query(
					"SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id",
				)
			).rows,
		).toEqual(history.rows);
		expect(
			(
				await pool.query(
					"SELECT attgenerated FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'search_vector'",
				)
			).rows[0].attgenerated,
		).toBe("s");
		expect(
			(
				await pool.query(
					"SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_search_vector_idx'",
				)
			).rows[0].indexdef,
		).toContain("USING gin (search_vector)");
	} finally {
		await pool.end();
		// Pool closure can precede the server observing the TCP FIN. Do not force-kill it.
		for (let attempt = 0; attempt < 100; attempt++) {
			const active = await admin.query(
				"SELECT 1 FROM pg_stat_activity WHERE datname=$1",
				[name],
			);
			if (!active.rows.length) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
		await admin.end();
	}
}, 30000);
