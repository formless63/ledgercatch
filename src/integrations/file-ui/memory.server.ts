import { FileError, type FileMetadata, type FileRecord } from "./contract";
/** Bounded, single-process fixture ONLY. Restart loses receipts; never use for durable uploads. */
export function createMemoryFileMetadata(capacity = 100): FileMetadata {
	if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000)
		throw new FileError("invalid_input");
	const rows = new Map<string, FileRecord>();
	const copy = (row: FileRecord | undefined) => (row ? { ...row } : undefined);
	return {
		async reserve(record) {
			const found = [...rows.values()].find(
				(r) =>
					r.owner === record.owner &&
					r.idempotencyKey === record.idempotencyKey,
			);
			if (found) return { created: false, record: { ...found } };
			if (rows.size >= capacity || rows.has(record.id))
				throw new FileError("unavailable");
			rows.set(record.id, { ...record });
			return { created: true, record: { ...record } };
		},
		async byToken(owner, token) {
			return copy(
				[...rows.values()].find(
					(r) => r.owner === owner && r.idempotencyKey === token,
				),
			);
		},
		async get(owner, id) {
			const row = rows.get(id);
			return row?.owner === owner ? copy(row) : undefined;
		},
		async list(owner, limit) {
			return [...rows.values()]
				.filter((r) => r.owner === owner)
				.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
				.slice(0, limit)
				.map((r) => ({ ...r }));
		},
		async cas(owner, id, revision, patch) {
			const row = rows.get(id);
			if (!row || row.owner !== owner || row.revision !== revision)
				return undefined;
			const next = { ...row, ...patch, revision: revision + 1 };
			rows.set(id, next);
			return { ...next };
		},
	};
}
