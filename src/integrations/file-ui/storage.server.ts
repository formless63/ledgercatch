import { storageConfig } from "../storage/config.server";
import { createStorage } from "../storage/storage.server";
/** One attempt prevents an earlier timed-out PUT racing a successful SDK retry and later cleanup. */
export function createFileStorage(config = storageConfig()) {
	return createStorage({
		...config,
		client: { ...config.client, maxAttempts: 1 },
	});
}
let storage: ReturnType<typeof createFileStorage> | undefined;
export function getFileStorage() {
	storage ??= createFileStorage();
	return storage;
}
