/**
 * Uploads queued items sequentially, applying the pure retry policy.
 * Triggered immediately after enqueue, by a 1-minute alarm, and by "Retry now".
 */
import { afterRetryableFailure, classifyStatus, parseRetryAfter, resetForManualRetry, selectDue } from "@/lib/outbox-policy";
import { getSettings, isConfigured } from "@/lib/settings";
import { getState, setState } from "@/lib/state";
import { errorMessage } from "@/lib/util";
import { HttpError, NetworkError, postCapture, postDocument } from "./api";
import { addHistory, bumpSentToday, refreshSummary, updateHistory } from "./history";
import { type OutboxItem, allItems, deleteItem, putItem } from "./outbox";

export const FLUSH_ALARM = "outbox-flush";

let running: Promise<void> | null = null;
let rerun = false;

/** Single-flight: concurrent callers share one run; a call during a run schedules one more pass. */
export function flushOutbox(): Promise<void> {
	if (running) {
		rerun = true;
		return running;
	}
	running = (async () => {
		try {
			do {
				rerun = false;
				await flushOnce();
			} while (rerun);
		} finally {
			running = null;
			await refreshSummary().catch(() => {});
		}
	})();
	return running;
}

async function upload(item: OutboxItem, settings: Awaited<ReturnType<typeof getSettings>>): Promise<"accepted" | "duplicate"> {
	if (item.type === "capture") return postCapture(settings, item.envelope);
	await postDocument(settings, item.meta, item.file);
	return "accepted";
}

async function flushOnce(): Promise<void> {
	const settings = await getSettings();
	if (!isConfigured(settings)) return;
	if (await getState("authPaused")) return;

	const due = selectDue(await allItems(), Date.now());
	for (const item of due) {
		try {
			const result = await upload(item, settings);
			await deleteItem(item.id);
			await updateHistory(item.historyId, { status: result === "duplicate" ? "duplicate" : "sent", message: undefined });
			await bumpSentToday();
			await markReachable();
		} catch (err) {
			const now = Date.now();
			if (err instanceof HttpError && err.status > 0) {
				const outcome = classifyStatus(err.status);
				if (outcome === "auth") {
					await setState("authPaused", { at: now, status: err.status });
					await setState("connection", {
						state: "auth_error",
						checkedAt: now,
						status: err.status,
						message: "Server rejected the API key. Fix it in Options; the queue is paused.",
					});
					return; // stop the whole run
				}
				if (outcome === "permanent") {
					await deleteItem(item.id);
					await updateHistory(item.historyId, { status: "error", message: err.message.slice(0, 300) });
					continue;
				}
				const next = afterRetryableFailure(item, err.message, now, parseRetryAfter(err.retryAfter, now));
				await putItem({ ...item, ...next });
				await updateHistory(item.historyId, {
					status: next.status === "failed" ? "error" : "retrying",
					message: `${err.message.slice(0, 200)} (attempt ${next.attempts})`,
				});
				if (err.status >= 500) return; // server unhealthy: back off the whole queue
				continue;
			}
			// Network error (or misconfiguration): back off and stop this run.
			const message = errorMessage(err);
			const next = afterRetryableFailure(item, message, now);
			await putItem({ ...item, ...next });
			await updateHistory(item.historyId, {
				status: next.status === "failed" ? "error" : "retrying",
				message: `${message.slice(0, 200)} (attempt ${next.attempts})`,
			});
			if (err instanceof NetworkError) {
				await setState("connection", { state: "unreachable", checkedAt: now, message });
			}
			return;
		}
	}
}

async function markReachable(): Promise<void> {
	const conn = await getState("connection");
	if (conn.state !== "ok") await setState("connection", { state: "ok", checkedAt: Date.now() });
}

/** "Retry now": un-pause, make everything due, and flush. */
export async function retryNow(): Promise<void> {
	await setState("authPaused", null);
	const now = Date.now();
	for (const item of await allItems()) {
		await putItem(resetForManualRetry(item, now));
	}
	await flushOutbox();
}

export async function enqueue(item: OutboxItem): Promise<void> {
	await putItem(item);
	await addHistory({
		id: item.historyId,
		at: item.createdAt,
		type: item.type,
		kind: item.type === "capture" ? item.envelope.kind : item.meta.kind,
		source: item.type === "capture" ? item.envelope.source : item.meta.source,
		pageType: item.type === "capture" ? item.envelope.pageType : undefined,
		url: item.type === "capture" ? item.envelope.pageUrl : (item.meta.originUrl ?? ""),
		label: item.label,
		status: "queued",
	});
	await refreshSummary();
	void flushOutbox();
}
