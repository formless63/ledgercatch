/**
 * Minimal raw-IndexedDB `QueueStore` (no `idb` dependency). One database,
 * one object store keyed by item id; Blobs are stored natively.
 */
import { memoryStore, type QueueItem, type QueueStore } from "./queue";

const DB_NAME = "ledgercatch-capture";
const DB_VERSION = 1;
const STORE = "queue";

function promisify<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function openDb(factory: IDBFactory) {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = factory.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE))
				db.createObjectStore(STORE, { keyPath: "id" });
		};
		request.onsuccess = () => {
			const db = request.result;
			// Let a future version upgrade proceed from another tab.
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error("IndexedDB blocked"));
	});
}

export function idbStore(factory: IDBFactory): QueueStore {
	let dbPromise: Promise<IDBDatabase> | null = null;
	const db = () => {
		dbPromise ??= openDb(factory).catch((error) => {
			dbPromise = null;
			throw error;
		});
		return dbPromise;
	};
	async function tx<T>(
		mode: IDBTransactionMode,
		run: (store: IDBObjectStore) => IDBRequest<T>,
	) {
		const transaction = (await db()).transaction(STORE, mode);
		const result = promisify(run(transaction.objectStore(STORE)));
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () =>
				reject(transaction.error ?? new Error("Transaction aborted"));
		});
		return result;
	}
	return {
		list: () => tx("readonly", (s) => s.getAll() as IDBRequest<QueueItem[]>),
		put: async (item) => {
			await tx("readwrite", (s) => s.put(item));
		},
		remove: async (id) => {
			await tx("readwrite", (s) => s.delete(id));
		},
	};
}

/** IndexedDB when usable (probed), otherwise a non-persistent memory store. */
export async function openQueueStore(): Promise<{
	store: QueueStore;
	persistent: boolean;
}> {
	try {
		if (typeof indexedDB === "undefined") throw new Error("No IndexedDB");
		const store = idbStore(indexedDB);
		await store.list();
		return { store, persistent: true };
	} catch {
		return { store: memoryStore(), persistent: false };
	}
}
