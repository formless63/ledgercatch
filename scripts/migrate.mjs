import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
	await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
	console.info("Database migrations applied successfully");
} finally {
	await pool.end();
}
