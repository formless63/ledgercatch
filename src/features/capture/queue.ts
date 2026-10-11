/**
 * Offline-tolerant upload queue for mobile receipt capture.
 *
 * Items are persisted through a `QueueStore` (IndexedDB in the browser, an
 * in-memory map in tests / when IndexedDB is unavailable). The queue is the
 * only writer; the UI subscribes to snapshots. Pending photos survive reloads
 * and are retried when the page regains connectivity or focus, with
 * exponential backoff for repeated failures. Successfully uploaded items drop
 * their file bytes and keep only a thumbnail + capture id for status display.
 *
 * Privacy: this stores the user's own photos in their browser's IndexedDB
 * for this origin only until they upload; nothing is put in Cache Storage and
 * the service worker is not involved.
 */
import type { StoreId } from "#/shared/capture";

export type CaptureMeta = {
	kind: "receipt" | "invoice";
	source: StoreId;
	merchantHint: string;
	entityId: string | null;
	note: string;
};

export type QueueStatus =
	| "pending"
	| "uploading"
	| "failed"
	| "rejected"
	| "uploaded";

export type QueueItem = {
	id: string;
	createdAt: number;
	fileName: string;
	contentType: string;
	size: number;
	originalSize: number;
	/** File bytes until uploaded; null afterwards (or for share-target items). */
	blob: Blob | null;
	thumbnail: string | null;
	meta: CaptureMeta;
	status: QueueStatus;
	attempts: number;
	nextAttemptAt: number;
	lastError: string | null;
	captureId: string | null;
	documentId: string | null;
	duplicate: boolean;
	uploadedAt: number | null;
};

export interface QueueStore {
	list(): Promise<QueueItem[]>;
	put(item: QueueItem): Promise<void>;
	remove(id: string): Promise<void>;
}

export type UploadOutcome =
	| {
			type: "ok";
			captureId: string;
			documentId: string | null;
			duplicate: boolean;
	  }
	| { type: "rejected"; error: string }
	| { type: "retry"; error: string; auth?: boolean };

export type Uploader = (
	item: QueueItem,
	onProgress: (fraction: number) => void,
) => Promise<UploadOutcome>;

export type NewQueueFile = {
	blob: Blob;
	fileName: string;
	contentType: string;
	originalSize: number;
	thumbnail: string | null;
};

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
export const KEEP_UPLOADED_MS = 3 * 24 * 60 * 60_000;
export const KEEP_UPLOADED_MAX = 40;

/** 5s, 10s, 20s … capped at 5 min. */
export function backoffMs(attempts: number) {
	const n = Math.max(1, Math.floor(attempts));
	return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (n - 1));
}

/** Pending/failed items with bytes whose backoff elapsed (or all if forced). */
export function isDue(item: QueueItem, now: number, force = false) {
	if (!item.blob) return false;
	if (item.status === "pending") return force || item.nextAttemptAt <= now;
	if (item.status === "failed") return force || item.nextAttemptAt <= now;
	return false;
}

/** Ids of uploaded items to forget: older than maxAge, or beyond the newest `keep`. */
export function pruneUploaded(
	items: QueueItem[],
	now: number,
	maxAgeMs = KEEP_UPLOADED_MS,
	keep = KEEP_UPLOADED_MAX,
) {
	const uploaded = items
		.filter((i) => i.status === "uploaded")
		.sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0));
	return uploaded
		.filter((item, index) => {
			const at = item.uploadedAt ?? item.createdAt;
			return index >= keep || now - at > maxAgeMs;
		})
		.map((i) => i.id);
}

/** Pure state transition for an upload outcome. */
export function applyOutcome(
	item: QueueItem,
	outcome: UploadOutcome,
	now: number,
): QueueItem {
	if (outcome.type === "ok")
		return {
			...item,
			status: "uploaded",
			blob: null,
			captureId: outcome.captureId,
			documentId: outcome.documentId,
			duplicate: outcome.duplicate,
			lastError: null,
			uploadedAt: now,
		};
	if (outcome.type === "rejected")
		return { ...item, status: "rejected", lastError: outcome.error };
	const attempts = item.attempts + 1;
	return {
		...item,
		status: "failed",
		attempts,
		lastError: outcome.error,
		nextAttemptAt: now + backoffMs(attempts),
	};
}

export function memoryStore(initial: QueueItem[] = []): QueueStore {
	const map = new Map(initial.map((i) => [i.id, i]));
	return {
		list: async () => [...map.values()],
		put: async (item) => {
			map.set(item.id, item);
		},
		remove: async (id) => {
			map.delete(id);
		},
	};
}

export type QueueSnapshot = {
	loaded: boolean;
	items: QueueItem[];
	progress: Record<string, number>;
	flushing: boolean;
	/** False when writes could not be persisted (no IndexedDB / quota). */
	persistent: boolean;
	/** Set after a 401: uploads pause until the next explicit retry/flush. */
	authRequired: boolean;
};

export type CaptureQueueOptions = {
	store: QueueStore;
	upload: Uploader;
	now?: () => number;
	isOnline?: () => boolean;
	newId?: () => string;
	/** False when `store` is the in-memory fallback. */
	persistent?: boolean;
};

function defaultId() {
	return typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createCaptureQueue(options: CaptureQueueOptions) {
	const now = options.now ?? Date.now;
	const isOnline = options.isOnline ?? (() => true);
	const newId = options.newId ?? defaultId;
	const items = new Map<string, QueueItem>();
	const listeners = new Set<() => void>();
	let snapshot: QueueSnapshot = {
		loaded: false,
		items: [],
		progress: {},
		flushing: false,
		persistent: options.persistent ?? true,
		authRequired: false,
	};
	let running: Promise<FlushSummary> | null = null;

	const emit = (patch: Partial<QueueSnapshot> = {}) => {
		snapshot = {
			...snapshot,
			...patch,
			items: [...items.values()].sort((a, b) => b.createdAt - a.createdAt),
		};
		for (const listener of listeners) listener();
	};

	async function save(item: QueueItem) {
		items.set(item.id, item);
		try {
			await options.store.put(item);
		} catch {
			snapshot = { ...snapshot, persistent: false };
		}
	}

	async function drop(id: string) {
		items.delete(id);
		const progress = { ...snapshot.progress };
		delete progress[id];
		snapshot = { ...snapshot, progress };
		try {
			await options.store.remove(id);
		} catch {
			snapshot = { ...snapshot, persistent: false };
		}
	}

	async function load() {
		let stored: QueueItem[] = [];
		try {
			stored = await options.store.list();
		} catch {
			snapshot = { ...snapshot, persistent: false };
		}
		for (const item of stored) {
			// A reload mid-upload: the request is gone, so queue it again.
			items.set(
				item.id,
				item.status === "uploading" ? { ...item, status: "pending" } : item,
			);
		}
		for (const id of pruneUploaded([...items.values()], now())) await drop(id);
		emit({ loaded: true });
	}

	async function enqueue(files: NewQueueFile[], meta: CaptureMeta) {
		const at = now();
		const added: QueueItem[] = files.map((file, index) => ({
			id: newId(),
			createdAt: at + index,
			fileName: file.fileName,
			contentType: file.contentType,
			size: file.blob.size,
			originalSize: file.originalSize,
			blob: file.blob,
			thumbnail: file.thumbnail,
			meta,
			status: "pending",
			attempts: 0,
			nextAttemptAt: 0,
			lastError: null,
			captureId: null,
			documentId: null,
			duplicate: false,
			uploadedAt: null,
		}));
		for (const item of added) await save(item);
		emit();
		return added.map((i) => i.id);
	}

	/** Records captures created server-side (share target) for status display. */
	async function recordUploaded(
		entries: Array<{ captureId: string; fileName?: string }>,
		meta: CaptureMeta,
	) {
		const known = new Set([...items.values()].map((i) => i.captureId));
		const at = now();
		for (const [index, entry] of entries.entries()) {
			if (known.has(entry.captureId)) continue;
			await save({
				id: newId(),
				createdAt: at + index,
				fileName: entry.fileName ?? "Shared file",
				contentType: "",
				size: 0,
				originalSize: 0,
				blob: null,
				thumbnail: null,
				meta,
				status: "uploaded",
				attempts: 0,
				nextAttemptAt: 0,
				lastError: null,
				captureId: entry.captureId,
				documentId: null,
				duplicate: false,
				uploadedAt: at,
			});
		}
		emit();
	}

	type FlushSummary = {
		uploaded: number;
		failed: number;
		rejected: number;
		skipped: "offline" | "auth" | null;
	};

	async function run(force: boolean): Promise<FlushSummary> {
		const summary: FlushSummary = {
			uploaded: 0,
			failed: 0,
			rejected: 0,
			skipped: null,
		};
		if (!isOnline()) {
			summary.skipped = "offline";
			return summary;
		}
		if (snapshot.authRequired && !force) {
			summary.skipped = "auth";
			return summary;
		}
		emit({ flushing: true, authRequired: false });
		try {
			while (true) {
				const next = [...items.values()]
					.filter((i) => isDue(i, now(), force))
					.sort((a, b) => a.createdAt - b.createdAt)[0];
				if (!next) break;
				const uploading: QueueItem = { ...next, status: "uploading" };
				await save(uploading);
				emit({ progress: { ...snapshot.progress, [next.id]: 0 } });
				let outcome: UploadOutcome;
				try {
					outcome = await options.upload(uploading, (fraction) =>
						emit({
							progress: {
								...snapshot.progress,
								[next.id]: Math.max(0, Math.min(1, fraction)),
							},
						}),
					);
				} catch (error) {
					outcome = {
						type: "retry",
						error: error instanceof Error ? error.message : "Upload failed",
					};
				}
				// Removed by the user while uploading.
				if (!items.has(next.id)) continue;
				const updated = applyOutcome(
					items.get(next.id) ?? uploading,
					outcome,
					now(),
				);
				await save(updated);
				const progress = { ...snapshot.progress };
				delete progress[next.id];
				emit({ progress });
				if (outcome.type === "ok") summary.uploaded += 1;
				else if (outcome.type === "rejected") summary.rejected += 1;
				else {
					summary.failed += 1;
					// Connectivity/auth problems affect every item: stop and wait
					// for the next trigger instead of burning through backoffs.
					if (outcome.auth) {
						summary.skipped = "auth";
						emit({ authRequired: true });
					}
					break;
				}
			}
		} finally {
			emit({ flushing: false });
		}
		return summary;
	}

	/** Uploads every due item sequentially; concurrent calls share one run. */
	function flush(force = false) {
		if (running) return running;
		running = run(force).finally(() => {
			running = null;
		});
		return running;
	}

	async function retry(id: string) {
		const item = items.get(id);
		if (!item?.blob || item.status === "uploading") return;
		await save({
			...item,
			status: "pending",
			nextAttemptAt: 0,
			lastError: null,
		});
		emit({ authRequired: false });
		return flush(true);
	}

	async function remove(id: string) {
		await drop(id);
		emit();
	}

	async function clearUploaded() {
		for (const item of [...items.values()])
			if (item.status === "uploaded") await drop(item.id);
		emit();
	}

	/** Earliest pending retry time (for scheduling a timer), or null. */
	function nextDueAt() {
		let next: number | null = null;
		for (const item of items.values())
			if (
				item.blob &&
				(item.status === "pending" || item.status === "failed") &&
				(next === null || item.nextAttemptAt < next)
			)
				next = item.nextAttemptAt;
		return next;
	}

	return {
		load,
		enqueue,
		recordUploaded,
		flush,
		retry,
		remove,
		clearUploaded,
		nextDueAt,
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export type CaptureQueue = ReturnType<typeof createCaptureQueue>;
