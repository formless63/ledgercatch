import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	appendAuditEvent,
	createAuditActor,
	createAuditSubject,
	queryAuditEvents,
} from "./audit.server";
import { auditEvents } from "./schema";

const sourceUrl =
	process.env.DATABASE_URL ??
	"postgresql://starter:starter@localhost:5432/starter";
const databaseName = `audit_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: sourceUrl });
const url = new URL(sourceUrl);
url.pathname = `/${databaseName}`;
const pool = new pg.Pool({ connectionString: url.toString() });
const db = drizzle(pool);
const domain = pgTable("audit_test_domain", { id: text("id").primaryKey() });
const event = {
	actor: createAuditActor("system"),
	action: "test.append",
	subject: createAuditSubject("fixture"),
	outcome: "success",
	metadata: { count: 1 },
};

describe("real PostgreSQL audit primitive", () => {
	beforeAll(async () => {
		await admin.query(`CREATE DATABASE "${databaseName}"`);
		await migrate(db, { migrationsFolder: "drizzle" });
		await db.execute(sql`CREATE TABLE audit_test_domain (id text PRIMARY KEY)`);
	}, 30000);
	afterAll(async () => {
		await pool.end();
		// Pool closure can precede the server observing the TCP FIN. Do not force-kill it.
		for (let attempt = 0; attempt < 100; attempt++) {
			const active = await admin.query(
				"SELECT 1 FROM pg_stat_activity WHERE datname=$1",
				[databaseName],
			);
			if (!active.rows.length) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
		await admin.end();
	});
	it("migrates a clean database with exactly the intended table, timestamp, UUID, JSONB, and indexes", async () => {
		const columns = await db.execute(
			sql`SELECT column_name, data_type, datetime_precision FROM information_schema.columns WHERE table_name = 'audit_event'`,
		);
		expect(columns.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					column_name: "created_at",
					data_type: "timestamp with time zone",
					datetime_precision: 3,
				}),
				expect.objectContaining({ column_name: "id", data_type: "uuid" }),
				expect.objectContaining({
					column_name: "metadata",
					data_type: "jsonb",
				}),
			]),
		);
		const indexes = await db.execute(
			sql`SELECT indexname FROM pg_indexes WHERE tablename = 'audit_event'`,
		);
		expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
			"audit_event_action_idx",
			"audit_event_actor_idx",
			"audit_event_pkey",
			"audit_event_subject_idx",
			"audit_event_time_idx",
		]);
	});
	it("appends nullable identities and primitive-owned timestamps/UUIDs", async () => {
		const started = Date.now();
		await expect(
			appendAuditEvent(db, {
				...event,
				createdAt: new Date(0),
			} as typeof event),
		).rejects.toMatchObject({ code: "INVALID_EVENT" });
		const rows = await Promise.all(
			Array.from({ length: 20 }, () => appendAuditEvent(db, event)),
		);
		expect(new Set(rows.map((row) => row.id)).size).toBe(20);
		expect(rows[0]).toMatchObject({
			actorId: null,
			subjectId: null,
			requestId: null,
			metadata: { count: 1 },
		});
		expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(started);
		expect(rows[0].id).toMatch(/^[\da-f-]{14}4[\da-f-]+$/);
	});
	it("enforces outcome/request bounds and rejects ID overrides", async () => {
		const row = await appendAuditEvent(db, {
			...event,
			outcome: "a".repeat(32),
			requestId: "r".repeat(128),
		});
		expect(row.outcome).toHaveLength(32);
		expect(row.requestId).toHaveLength(128);
		for (const extra of [
			{ outcome: "a".repeat(33) },
			{ requestId: "r".repeat(129) },
			{ id: "override" },
		])
			await expect(
				appendAuditEvent(db, { ...event, ...extra }),
			).rejects.toMatchObject({ code: "INVALID_EVENT" });
	});
	it("commits domain and audit together and rolls both back on caller or validation failure", async () => {
		await db.transaction(async (tx) => {
			await tx.insert(domain).values({ id: "commit" });
			await appendAuditEvent(tx, {
				...event,
				subject: createAuditSubject("fixture", "commit"),
			});
		});
		for (const [id, metadata] of [
			["rollback", {}],
			["invalid", { token: "private" }],
		] as const) {
			await expect(
				db.transaction(async (tx) => {
					await tx.insert(domain).values({ id });
					await appendAuditEvent(tx, {
						...event,
						subject: createAuditSubject("fixture", id),
						metadata,
					});
					throw new Error("caller rollback");
				}),
			).rejects.toThrow();
			expect(
				await db.select().from(domain).where(eq(domain.id, id)),
			).toHaveLength(0);
			expect(
				(await queryAuditEvents(db, { subjectId: id })).events,
			).toHaveLength(0);
		}
		expect(
			await db.select().from(domain).where(eq(domain.id, "commit")),
		).toHaveLength(1);
		expect(
			(await queryAuditEvents(db, { subjectId: "commit" })).events,
		).toHaveLength(1);
	});
	it("database audit failure rolls back a required transaction and returns only a safe error", async () => {
		await expect(
			db.transaction(async (tx) => {
				await tx.insert(domain).values({ id: "db-failure" });
				await tx.execute(
					sql`ALTER TABLE audit_event RENAME TO temporarily_unavailable`,
				);
				await appendAuditEvent(tx, event);
			}),
		).rejects.toThrow("Audit log operation failed");
		expect(
			await db.select().from(domain).where(eq(domain.id, "db-failure")),
		).toHaveLength(0);
		expect((await queryAuditEvents(db)).events.length).toBeGreaterThan(0);
	});
	it("uses stable descending keysets with tied times, insertion between pages, filters, and no duplicates", async () => {
		const actor = createAuditActor("job", "pagination");
		const stamp = new Date("2026-02-01T01:00:00.123Z");
		const rows = [];
		for (let i = 0; i < 7; i++)
			rows.push(
				await appendAuditEvent(db, {
					...event,
					actor,
					subject: createAuditSubject("fixture", "pages"),
					requestId: "safe-request",
				}),
			);
		for (const [i, row] of rows.entries()) {
			row.createdAt = new Date(stamp.getTime() + Math.floor(i / 3));
			await db
				.update(auditEvents)
				.set({ createdAt: row.createdAt })
				.where(eq(auditEvents.id, row.id));
		}
		const filters = {
			actorType: "job",
			actorId: "pagination",
			subjectType: "fixture",
			subjectId: "pages",
			action: "test.append",
			outcome: "success",
			from: stamp,
			until: new Date(stamp.getTime() + 3),
			limit: 2,
		};
		const boundary = await queryAuditEvents(db, {
			...filters,
			from: stamp,
			until: new Date(stamp.getTime() + 1),
			limit: 100,
		});
		expect(boundary.events).toHaveLength(3);
		await expect(
			queryAuditEvents(db, { from: stamp, until: stamp }),
		).rejects.toMatchObject({ code: "INVALID_QUERY" });
		const first = await queryAuditEvents(db, filters);
		expect(first).toEqual(await queryAuditEvents(db, filters));
		await appendAuditEvent(db, {
			...event,
			actor,
		});
		const collected = [...first.events];
		let cursor = first.nextCursor;
		while (cursor) {
			const page = await queryAuditEvents(db, { ...filters, cursor });
			collected.push(...page.events);
			cursor = page.nextCursor;
		}
		const sorted = [...rows].sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() ||
				b.id.localeCompare(a.id),
		);
		expect(collected.map((row) => row.id)).toEqual(sorted.map((row) => row.id));
		expect(new Set(collected.map((row) => row.id)).size).toBe(7);
		expect(
			(await queryAuditEvents(db, { actorId: "absent" })).events,
		).toHaveLength(0);
	});
	it("bounds page sizes and safely rejects malformed cursors, dates, and unsupported filters", async () => {
		for (const limit of [0, -1, 101, 1.5, NaN])
			await expect(queryAuditEvents(db, { limit })).rejects.toMatchObject({
				code: "INVALID_QUERY",
			});
		for (const cursor of [
			"",
			"!",
			"e30",
			"a".repeat(257),
			Buffer.from(JSON.stringify([2, "bad", "bad"])).toString("base64url"),
		])
			await expect(queryAuditEvents(db, { cursor })).rejects.toMatchObject({
				code: "INVALID_QUERY",
			});
		await expect(
			queryAuditEvents(db, { from: new Date("invalid") }),
		).rejects.toMatchObject({ code: "INVALID_QUERY" });
		await expect(
			queryAuditEvents(db, {
				from: new Date("2027-01-01"),
				until: new Date("2026-01-01"),
			}),
		).rejects.toMatchObject({ code: "INVALID_QUERY" });
		expect(
			(await queryAuditEvents(db, { limit: 100 })).events.length,
		).toBeLessThanOrEqual(100);
	});
	it("application removal does not cascade away historical generic IDs", async () => {
		await db.delete(domain).where(eq(domain.id, "commit"));
		expect(
			await db
				.select()
				.from(auditEvents)
				.where(
					and(
						eq(auditEvents.subjectId, "commit"),
						eq(auditEvents.action, "test.append"),
					),
				),
		).toHaveLength(1);
	});
});
