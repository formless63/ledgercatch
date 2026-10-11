/**
 * Extension state kept in chrome.storage.local so every context (popup,
 * options, service worker) can read it and react via storage.onChanged.
 */
import type { PageType, StoreId } from "@app/shared/capture";
import { browser } from "wxt/browser";

export type ConnectionState =
	| { state: "unconfigured" }
	| { state: "unknown" }
	| { state: "ok"; checkedAt: number; userName?: string; userEmail?: string; serverAppName?: string }
	| { state: "auth_error"; checkedAt: number; status: number; message: string }
	| { state: "unreachable"; checkedAt: number; message: string };

export type HistoryStatus = "queued" | "sent" | "duplicate" | "skipped" | "error" | "retrying";

export interface HistoryEntry {
	id: string;
	at: number;
	/** "capture" entries carry kind/pageType; "document" entries carry fileName. */
	type: "capture" | "document";
	kind?: string;
	source: StoreId;
	pageType?: PageType;
	url: string;
	label: string;
	status: HistoryStatus;
	message?: string;
}

export interface OutboxSummary {
	pending: number;
	failed: number;
	updatedAt: number;
}

export interface DailyStats {
	day: string;
	sent: number;
}

export interface InvoiceJobItem {
	url: string;
	label: string;
	status: "pending" | "working" | "uploaded" | "snapshot" | "error";
	message?: string;
}

export interface InvoiceJob {
	id: string;
	tabId: number;
	startedAt: number;
	finishedAt?: number;
	items: InvoiceJobItem[];
}

export interface EnrichmentRunSummary {
	at: number;
	fetched: number;
	tabs: number;
	skipped: number;
	failed: number;
	/** Store domains stopped for sign-in, blocking or an unready rendered page. */
	stoppedDomains: string[];
	message?: string;
}

export interface EnrichmentState {
	/** Server-side pending extension_fetch tasks (last known). */
	pending: number;
	checkedAt: number;
	running: boolean;
	lastRun: EnrichmentRunSummary | null;
}

export interface StateShape {
	connection: ConnectionState;
	history: HistoryEntry[];
	outboxSummary: OutboxSummary;
	stats: DailyStats;
	/** Set when the server answered 401/403; the flusher pauses until cleared. */
	authPaused: { at: number; status: number } | null;
	invoiceJob: InvoiceJob | null;
	/** sha256 -> last-sent epoch ms, for 24h passive de-duplication. */
	recentHashes: Record<string, number>;
	/** Auto-detected order page URL -> first-sent epoch ms ("once per URL"). */
	detectedUrls: Record<string, number>;
	enrichment: EnrichmentState;
}

export const STATE_DEFAULTS: StateShape = {
	connection: { state: "unknown" },
	history: [],
	outboxSummary: { pending: 0, failed: 0, updatedAt: 0 },
	stats: { day: "", sent: 0 },
	authPaused: null,
	invoiceJob: null,
	recentHashes: {},
	detectedUrls: {},
	enrichment: { pending: 0, checkedAt: 0, running: false, lastRun: null },
};

export type StateKey = keyof StateShape;

export async function getState<K extends StateKey>(key: K): Promise<StateShape[K]> {
	const got = await browser.storage.local.get(key);
	return (got[key] as StateShape[K] | undefined) ?? STATE_DEFAULTS[key];
}

export async function setState<K extends StateKey>(key: K, value: StateShape[K]): Promise<void> {
	await browser.storage.local.set({ [key]: value });
}

export const HISTORY_LIMIT = 100;
