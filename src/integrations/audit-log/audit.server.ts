import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditEvents } from "./schema";
import {
	type AuditIdentity,
	AuditLogError,
	actionIdentifier,
	auditDate,
	boundedString,
	createAuditActor,
	createAuditSubject,
	identifier,
	optionalId,
	validateAuditMetadata,
} from "./validation";

export {
	AuditLogError,
	createAuditActor,
	createAuditSubject,
} from "./validation";
// Structural method picks accept both a configured DB and its transaction without casts.
export type AuditWriter = Pick<NodePgDatabase, "insert">;
export type AuditReader = Pick<NodePgDatabase, "select">;
export interface AuditEventInput {
	actor: AuditIdentity;
	action: string;
	subject: AuditIdentity;
	outcome?: string | null;
	requestId?: string | null;
	metadata?: unknown;
}
export async function appendAuditEvent(
	dbOrTx: AuditWriter,
	event: AuditEventInput,
) {
	if (
		Object.keys(event).some(
			(key) =>
				![
					"actor",
					"action",
					"subject",
					"outcome",
					"requestId",
					"metadata",
				].includes(key),
		)
	)
		throw new AuditLogError("INVALID_EVENT");
	const actor = createAuditActor(event.actor?.type, event.actor?.id);
	const subject = createAuditSubject(event.subject?.type, event.subject?.id);
	const values = {
		id: randomUUID(),
		createdAt: new Date(),
		actorType: actor.type,
		actorId: actor.id,
		subjectType: subject.type,
		subjectId: subject.id,
		action: actionIdentifier(event.action),
		outcome: event.outcome == null ? null : identifier(event.outcome, 32),
		requestId: optionalId(event.requestId, 128),
		metadata: validateAuditMetadata(event.metadata),
	};
	try {
		const [row] = await dbOrTx.insert(auditEvents).values(values).returning();
		return row;
	} catch {
		throw new AuditLogError("DATABASE_ERROR");
	}
}
export interface AuditQuery {
	actorType?: string;
	actorId?: string;
	subjectType?: string;
	subjectId?: string;
	action?: string;
	outcome?: string;
	from?: Date;
	until?: Date;
	limit?: number;
	cursor?: string;
}
function encodeCursor(row: { createdAt: Date; id: string }) {
	return Buffer.from(
		JSON.stringify([1, row.createdAt.toISOString(), row.id]),
	).toString("base64url");
}
function decodeCursor(value: string) {
	if (
		typeof value !== "string" ||
		value.length > 256 ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	)
		throw new AuditLogError("INVALID_QUERY");
	const decoded: unknown = JSON.parse(
		Buffer.from(value, "base64url").toString("utf8"),
	);
	if (
		!Array.isArray(decoded) ||
		decoded.length !== 3 ||
		decoded[0] !== 1 ||
		typeof decoded[1] !== "string" ||
		typeof decoded[2] !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			decoded[2],
		)
	)
		throw new AuditLogError("INVALID_QUERY");
	const row = { createdAt: auditDate(new Date(decoded[1])), id: decoded[2] };
	if (encodeCursor(row) !== value) throw new AuditLogError("INVALID_QUERY");
	return row;
}
export async function queryAuditEvents(
	db: AuditReader,
	filters: AuditQuery = {},
) {
	const conditions: SQL[] = [];
	const limit = filters.limit ?? 50;
	try {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new AuditLogError("INVALID_QUERY");
		for (const key of Object.keys(filters))
			if (
				![
					"actorType",
					"actorId",
					"subjectType",
					"subjectId",
					"action",
					"outcome",
					"from",
					"until",
					"limit",
					"cursor",
				].includes(key)
			)
				throw new AuditLogError("INVALID_QUERY");
		if (filters.actorType !== undefined)
			conditions.push(
				eq(auditEvents.actorType, identifier(filters.actorType, 32)),
			);
		if (filters.actorId !== undefined)
			conditions.push(
				eq(auditEvents.actorId, boundedString(filters.actorId, 128)),
			);
		if (filters.subjectType !== undefined)
			conditions.push(
				eq(auditEvents.subjectType, identifier(filters.subjectType)),
			);
		if (filters.subjectId !== undefined)
			conditions.push(
				eq(auditEvents.subjectId, boundedString(filters.subjectId, 128)),
			);
		if (filters.action !== undefined)
			conditions.push(eq(auditEvents.action, actionIdentifier(filters.action)));
		if (filters.outcome !== undefined)
			conditions.push(eq(auditEvents.outcome, identifier(filters.outcome, 32)));
		if (filters.from !== undefined)
			conditions.push(gte(auditEvents.createdAt, auditDate(filters.from)));
		if (filters.until !== undefined)
			conditions.push(lt(auditEvents.createdAt, auditDate(filters.until)));
		if (filters.from && filters.until && filters.from >= filters.until)
			throw new AuditLogError("INVALID_QUERY");
		if (filters.cursor !== undefined) {
			const cursor = decodeCursor(filters.cursor);
			conditions.push(
				sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
			);
		}
	} catch {
		throw new AuditLogError("INVALID_QUERY");
	}
	try {
		const rows = await db
			.select()
			.from(auditEvents)
			.where(and(...conditions))
			.orderBy(
				sql`${auditEvents.createdAt} desc nulls last`,
				sql`${auditEvents.id} desc nulls last`,
			)
			.limit(limit + 1);
		const events = rows.slice(0, limit);
		return {
			events,
			nextCursor:
				rows.length > limit ? encodeCursor(events[events.length - 1]) : null,
		};
	} catch {
		throw new AuditLogError("DATABASE_ERROR");
	}
}
