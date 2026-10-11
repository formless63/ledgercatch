/** Recent-activity log + counters shown in the popup (chrome.storage.local). */
import { browser } from "wxt/browser";
import { HISTORY_LIMIT, type HistoryEntry, type StateShape, getState, setState } from "@/lib/state";
import { localDay } from "@/lib/util";
import { counts } from "./outbox";

/** Serialize read-modify-write cycles on storage keys within this worker. */
let chain: Promise<unknown> = Promise.resolve();
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.catch(() => undefined);
	return next;
}

export function addHistory(entry: HistoryEntry): Promise<void> {
	return serialized(async () => {
		const history = await getState("history");
		await setState("history", [entry, ...history.filter((h) => h.id !== entry.id)].slice(0, HISTORY_LIMIT));
	});
}

export function updateHistory(id: string, patch: Partial<HistoryEntry>): Promise<void> {
	return serialized(async () => {
		const history = await getState("history");
		const idx = history.findIndex((h) => h.id === id);
		if (idx < 0) return;
		const next = [...history];
		next[idx] = { ...next[idx], ...patch } as HistoryEntry;
		await setState("history", next);
	});
}

export function bumpSentToday(): Promise<void> {
	return serialized(async () => {
		const today = localDay(Date.now());
		const stats = await getState("stats");
		await setState("stats", stats.day === today ? { day: today, sent: stats.sent + 1 } : { day: today, sent: 1 });
	});
}

const BADGE_COLORS = { pending: "#38BDF8", error: "#EF4444", auth: "#F59E0B" } as const;

/** Recompute the outbox summary and the toolbar badge. */
export async function refreshSummary(): Promise<StateShape["outboxSummary"]> {
	const { pending, failed } = await counts();
	const summary = { pending, failed, updatedAt: Date.now() };
	await setState("outboxSummary", summary);
	const paused = await getState("authPaused");
	let text = "";
	let color: string = BADGE_COLORS.pending;
	if (paused) {
		text = "!";
		color = BADGE_COLORS.auth;
	} else if (failed > 0) {
		text = String(failed > 99 ? "99+" : failed);
		color = BADGE_COLORS.error;
	} else if (pending > 0) {
		text = String(pending > 99 ? "99+" : pending);
	}
	try {
		await browser.action.setBadgeText({ text });
		await browser.action.setBadgeBackgroundColor({ color });
		await browser.action.setBadgeTextColor?.({ color: "#0B0F17" });
	} catch {
		/* badge API unavailable */
	}
	return summary;
}
