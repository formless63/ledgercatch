export type FileState = "uploading" | "ready" | "cleanup-pending" | "removed";
export interface FileView {
	id: string;
	name: string;
	type: string;
	size: number;
	state: FileState;
}
export interface FileRecord extends FileView {
	owner: string;
	key: string;
	idempotencyKey: string;
	digest: string;
	fingerprint: string;
	revision: number;
	writerStopped: boolean;
	createdAt: number;
}
/** Every method is atomic and owner-scoped. Receipts must survive process restart in production. */
export interface FileMetadata {
	reserve(
		record: FileRecord,
	): Promise<{ created: boolean; record: FileRecord }>;
	byToken(owner: string, token: string): Promise<FileRecord | undefined>;
	get(owner: string, id: string): Promise<FileRecord | undefined>;
	list(owner: string, limit: number): Promise<FileRecord[]>;
	cas(
		owner: string,
		id: string,
		revision: number,
		patch: Pick<FileRecord, "state" | "writerStopped">,
	): Promise<FileRecord | undefined>;
}
export interface FileContext {
	owner: string;
	signal?: AbortSignal;
}
export class FileError extends Error {
	constructor(
		public code:
			| "invalid_input"
			| "too_large"
			| "conflict"
			| "not_found"
			| "unavailable"
			| "cancelled"
			| "forbidden",
	) {
		super(code);
		this.name = "FileError";
	}
}
export function fileView(record: FileRecord): FileView {
	const { id, name, type, size, state } = record;
	return { id, name, type, size, state };
}
