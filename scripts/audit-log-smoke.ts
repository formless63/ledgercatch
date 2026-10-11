import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { appendAuditEvent, createAuditActor, createAuditSubject, queryAuditEvents } from "../src/integrations/audit-log/audit.server";

const url = process.env.DATABASE_URL;
assert.ok(url, "DATABASE_URL must select a migrated non-production test database");
const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);
const subjectId = `smoke-${randomUUID()}`;
const event = { actor: createAuditActor("system"), action: "audit.smoke", subject: createAuditSubject("fixture", subjectId), outcome: "success", metadata: { source: "smoke" } };
const domain = pgTable("audit_smoke_domain", { id: text("id").primaryKey() });
try {
	await db.transaction(async tx => {
		await tx.execute(sql`CREATE TEMP TABLE audit_smoke_domain (id text PRIMARY KEY) ON COMMIT DROP`);
		await tx.insert(domain).values({ id: subjectId });
		await appendAuditEvent(tx, event);
		assert.equal((await tx.select().from(domain).where(eq(domain.id, subjectId))).length, 1);
	});
	for (const invalid of [false, true]) {
		await assert.rejects(db.transaction(async tx => {
			await tx.execute(sql`CREATE TEMP TABLE audit_smoke_domain (id text PRIMARY KEY) ON COMMIT DROP`);
			await tx.insert(domain).values({ id: `${subjectId}-rollback` });
			await appendAuditEvent(tx, { ...event, subject: createAuditSubject("fixture", `${subjectId}-rollback`), metadata: invalid ? { accessToken: "must reject" } : {} });
			throw new Error("intentional rollback");
		}));
		assert.equal((await queryAuditEvents(db, { subjectId: `${subjectId}-rollback` })).events.length, 0);
	}
	await appendAuditEvent(db, event);
	const first = await queryAuditEvents(db, { action: "audit.smoke", subjectId, limit: 1 });
	assert.ok(first.nextCursor);
	const second = await queryAuditEvents(db, { action: "audit.smoke", subjectId, limit: 1, cursor: first.nextCursor });
	assert.equal(second.events.length, 1);
	assert.notEqual(first.events[0].id, second.events[0].id);
	assert.equal(second.nextCursor, null);
	await assert.rejects(queryAuditEvents(db, { cursor: "!invalid" }));
	await assert.rejects(queryAuditEvents(db, { limit: 101 }));
	console.info("Audit Log PostgreSQL append, coupled transactions, safety and keyset smoke passed");
} finally { await pool.end(); }
