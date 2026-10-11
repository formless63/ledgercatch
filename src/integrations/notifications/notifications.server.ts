import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { notifications } from "./schema";
import {
	boundedString,
	NotificationError,
	validateNotificationMetadata,
} from "./validation";

export { NotificationError } from "./validation";
export const notificationType = z
	.string()
	.max(128)
	.regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/);
export const notificationInput = z.strictObject({
	recipientId: z.string().min(1).max(128),
	type: notificationType,
	title: z
		.string()
		.min(1)
		.max(200)
		.refine((value) => value.trim().length > 0),
	body: z.string(),
	metadata: z.unknown().optional(),
});
export type NotificationInput = z.input<typeof notificationInput>;
export type NotificationWriter = Pick<NodePgDatabase, "insert">;
export function notificationValues(input: NotificationInput) {
	try {
		const parsed = notificationInput.parse(input);
		boundedString(parsed.recipientId, 128);
		if (
			/\p{Cc}/u.test(parsed.title) ||
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
				parsed.title,
			)
		)
			throw new NotificationError("invalid-input");
		// Plain text only; applications render with escaping, never innerHTML.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: reject non-text controls while allowing plain-text tab/newline.
		const bodyControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
		if (
			Buffer.byteLength(parsed.body) > 4096 ||
			bodyControls.test(parsed.body) ||
			/<\/?[a-z!][^>]*>/i.test(parsed.body) ||
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
				parsed.body,
			)
		)
			throw new NotificationError("invalid-input");
		return {
			...parsed,
			metadata: validateNotificationMetadata(parsed.metadata),
			id: randomUUID(),
			createdAt: new Date(),
			readAt: null,
		};
	} catch {
		throw new NotificationError("invalid-input");
	}
}
export async function createNotification(
	executor: NotificationWriter,
	input: NotificationInput,
) {
	const values = notificationValues(input);
	try {
		const [row] = await executor
			.insert(notifications)
			.values(values)
			.returning();
		if (!row) throw new NotificationError("unavailable");
		return row;
	} catch {
		throw new NotificationError("unavailable");
	}
}
export interface NotificationQuery {
	unreadOnly?: boolean;
	type?: string;
	limit?: number;
	cursor?: string;
}
export function encodeNotificationCursor(row: { createdAt: Date; id: string }) {
	return Buffer.from(
		JSON.stringify([1, row.createdAt.toISOString(), row.id]),
	).toString("base64url");
}
export function decodeNotificationCursor(value: string) {
	try {
		if (
			typeof value !== "string" ||
			value.length > 256 ||
			!/^[A-Za-z0-9_-]+$/.test(value)
		)
			throw new Error();
		const decoded: unknown = JSON.parse(
			Buffer.from(value, "base64url").toString(),
		);
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 3 ||
			decoded[0] !== 1 ||
			typeof decoded[1] !== "string" ||
			!z.uuid().safeParse(decoded[2]).success
		)
			throw new Error();
		const row = { createdAt: new Date(decoded[1]), id: decoded[2] as string };
		if (encodeNotificationCursor(row) !== value) throw new Error();
		return row;
	} catch {
		throw new NotificationError("invalid-input");
	}
}
export async function queryNotifications(
	executor: Pick<NodePgDatabase, "select">,
	recipientId: string,
	filters: NotificationQuery = {},
) {
	boundedString(recipientId, 128);
	const limit = filters.limit ?? 25,
		conditions: SQL[] = [eq(notifications.recipientId, recipientId)];
	if (
		Object.keys(filters).some(
			(k) => !["unreadOnly", "type", "limit", "cursor"].includes(k),
		) ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		(filters.unreadOnly !== undefined &&
			typeof filters.unreadOnly !== "boolean")
	)
		throw new NotificationError("invalid-input");
	if (filters.unreadOnly) conditions.push(isNull(notifications.readAt));
	if (filters.type !== undefined) {
		if (!notificationType.safeParse(filters.type).success)
			throw new NotificationError("invalid-input");
		conditions.push(eq(notifications.type, filters.type));
	}
	if (filters.cursor !== undefined) {
		const cursor = decodeNotificationCursor(filters.cursor);
		conditions.push(
			sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
		);
	}
	try {
		const rows = await executor
			.select()
			.from(notifications)
			.where(and(...conditions))
			.orderBy(desc(notifications.createdAt), desc(notifications.id))
			.limit(limit + 1);
		const items = rows.slice(0, limit);
		return {
			notifications: items,
			nextCursor:
				rows.length > limit
					? encodeNotificationCursor(items[items.length - 1])
					: null,
		};
	} catch {
		throw new NotificationError("unavailable");
	}
}
async function setRead(
	executor: Pick<NodePgDatabase, "update">,
	recipientId: string,
	id: string,
	read: boolean,
) {
	boundedString(recipientId, 128);
	if (!z.uuid().safeParse(id).success)
		throw new NotificationError("invalid-input");
	try {
		const rows = await executor
			.update(notifications)
			.set({
				readAt: read ? sql`coalesce(${notifications.readAt}, now())` : null,
			})
			.where(
				and(
					eq(notifications.recipientId, recipientId),
					eq(notifications.id, id),
				),
			)
			.returning({ id: notifications.id });
		return rows.length === 1;
	} catch {
		throw new NotificationError("unavailable");
	}
}
export const markRead = (
	executor: Pick<NodePgDatabase, "update">,
	recipientId: string,
	id: string,
) => setRead(executor, recipientId, id, true);
export const markUnread = (
	executor: Pick<NodePgDatabase, "update">,
	recipientId: string,
	id: string,
) => setRead(executor, recipientId, id, false);
