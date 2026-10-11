import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createJobsBoss, jobsDatabaseUrl } from "./boss.server";

// Own only this uniquely named disposable schema; never alter the application queue schema.
const schema = `jobs_release_${crypto.randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: jobsDatabaseUrl() });

afterAll(async () => {
	await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	await pool.end();
});

describe("explicit Jobs release gates", () => {
	it("refuses an absent schema without installing it, then allows explicit migration", async () => {
		const producer = createJobsBoss("producer", { schema });
		try {
			await expect(producer.start()).rejects.toThrow("not installed");
			const result = await pool.query(
				"SELECT 1 FROM pg_namespace WHERE nspname = $1",
				[schema],
			);
			expect(result.rowCount).toBe(0);
		} finally {
			await producer.stop({ graceful: false });
		}
		const migration = createJobsBoss("migration", { schema });
		try {
			await migration.start();
			expect((await migration.detectSchemaDrift()).ok).toBe(true);
		} finally {
			await migration.stop({ graceful: true });
		}
	});
	it("blocks a version mismatch without silently upgrading from a long-lived role", async () => {
		const admin = createJobsBoss("admin", { schema });
		let version = 0;
		try {
			await admin.start();
			const installed = await admin.schemaVersion();
			if (installed === null) throw new Error("Missing fixture version");
			version = installed;
		} finally {
			await admin.stop();
		}
		await pool.query(`UPDATE "${schema}".version SET version = $1`, [
			version - 1,
		]);
		const worker = createJobsBoss("worker", { schema });
		try {
			await expect(worker.start()).rejects.toThrow("requires migrations");
			const { rows } = await pool.query(
				`SELECT version FROM "${schema}".version`,
			);
			expect(rows[0]?.version).toBe(version - 1);
		} finally {
			await worker.stop({ graceful: false });
			await pool.query(`UPDATE "${schema}".version SET version = $1`, [
				version,
			]);
		}
	});
	it("makes doctor fail release on structural drift even when the schema version matches", async () => {
		const { rows } = await pool.query<{ indexname: string }>(
			"SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'job_common' AND indexdef NOT LIKE 'CREATE UNIQUE%' ORDER BY indexname LIMIT 1",
			[schema],
		);
		const index = rows[0]?.indexname;
		if (!index || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(index))
			throw new Error("Missing fixture index");
		await pool.query(`DROP INDEX "${schema}"."${index}"`);
		const doctor = spawnSync("bun", ["scripts/jobs-doctor.ts"], {
			env: { ...process.env, PGBOSS_SCHEMA: schema },
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(doctor.status).toBe(1);
		expect(doctor.stdout).toContain('"ok":false');
		// A migration with the current version does not promise to repair manual drift.
		const migration = createJobsBoss("migration", { schema });
		try {
			await migration.start();
			expect((await migration.detectSchemaDrift()).ok).toBe(false);
		} finally {
			await migration.stop();
		}
	});
});
