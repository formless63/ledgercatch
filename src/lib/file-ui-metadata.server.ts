import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { fileUiFiles } from "../db/file-ui-schema";
import {
	FileError,
	type FileMetadata,
	type FileRecord,
} from "../integrations/file-ui/contract";
export function createPostgresFileMetadata<T extends Record<string, unknown>>(
	db: NodePgDatabase<T>,
): FileMetadata {
	const scoped = (owner: string, id: string) =>
		and(eq(fileUiFiles.owner, owner), eq(fileUiFiles.id, id));
	const adapter: FileMetadata = {
		async reserve(record) {
			const [created] = await db
				.insert(fileUiFiles)
				.values(record)
				.onConflictDoNothing({
					target: [fileUiFiles.owner, fileUiFiles.idempotencyKey],
				})
				.returning();
			if (created) return { created: true, record: created };
			const found = await adapter.byToken(record.owner, record.idempotencyKey);
			if (!found) throw new FileError("unavailable");
			return { created: false, record: found };
		},
		async byToken(owner, token) {
			return (
				await db
					.select()
					.from(fileUiFiles)
					.where(
						and(
							eq(fileUiFiles.owner, owner),
							eq(fileUiFiles.idempotencyKey, token),
						),
					)
					.limit(1)
			)[0];
		},
		async get(owner, id) {
			return (
				await db.select().from(fileUiFiles).where(scoped(owner, id)).limit(1)
			)[0];
		},
		async list(owner, limit) {
			return db
				.select()
				.from(fileUiFiles)
				.where(eq(fileUiFiles.owner, owner))
				.orderBy(desc(fileUiFiles.createdAt), fileUiFiles.id)
				.limit(Math.min(100, limit));
		},
		async cas(owner, id, revision, patch) {
			return (
				await db
					.update(fileUiFiles)
					.set({ ...patch, revision: sql`${fileUiFiles.revision} + 1` })
					.where(and(scoped(owner, id), eq(fileUiFiles.revision, revision)))
					.returning()
			)[0] as FileRecord | undefined;
		},
	};
	return adapter;
}
