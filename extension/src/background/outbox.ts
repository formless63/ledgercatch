/** Durable upload queue in IndexedDB (survives service-worker restarts). */
import type { CaptureEnvelope, DocumentUploadMeta } from "@app/shared/capture";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { RetryState } from "@/lib/outbox-policy";

interface ItemBase extends RetryState {
	id: string;
	createdAt: number;
	label: string;
	historyId: string;
}

export interface CaptureItem extends ItemBase {
	type: "capture";
	envelope: CaptureEnvelope;
}

export interface DocumentItem extends ItemBase {
	type: "document";
	meta: DocumentUploadMeta;
	file: Blob;
}

export type OutboxItem = CaptureItem | DocumentItem;

interface OutboxDb extends DBSchema {
	outbox: { key: string; value: OutboxItem };
}

let dbPromise: Promise<IDBPDatabase<OutboxDb>> | null = null;

function db(): Promise<IDBPDatabase<OutboxDb>> {
	dbPromise ??= openDB<OutboxDb>("ledgercatch", 1, {
		upgrade(database) {
			database.createObjectStore("outbox", { keyPath: "id" });
		},
	});
	return dbPromise;
}

export async function putItem(item: OutboxItem): Promise<void> {
	await (await db()).put("outbox", item);
}

export async function getItem(id: string): Promise<OutboxItem | undefined> {
	return (await db()).get("outbox", id);
}

export async function deleteItem(id: string): Promise<void> {
	await (await db()).delete("outbox", id);
}

export async function allItems(): Promise<OutboxItem[]> {
	return (await db()).getAll("outbox");
}

export async function clearItems(): Promise<number> {
	const d = await db();
	const count = await d.count("outbox");
	await d.clear("outbox");
	return count;
}

export async function counts(): Promise<{ pending: number; failed: number }> {
	const items = await allItems();
	let pending = 0;
	let failed = 0;
	for (const i of items) i.status === "failed" ? failed++ : pending++;
	return { pending, failed };
}
