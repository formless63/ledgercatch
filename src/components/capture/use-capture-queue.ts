/**
 * Browser wiring for the capture queue: opens IndexedDB after mount, and
 * flushes on mount, `online`, window focus / tab visibility and when the
 * earliest backoff elapses. SSR renders an empty, unloaded snapshot.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { openQueueStore } from "#/features/capture/idb-store";
import {
	type CaptureQueue,
	createCaptureQueue,
	type QueueSnapshot,
} from "#/features/capture/queue";
import { xhrUpload } from "#/features/capture/upload";

const EMPTY: QueueSnapshot = {
	loaded: false,
	items: [],
	progress: {},
	flushing: false,
	persistent: true,
	authRequired: false,
};
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function useOnline() {
	return useSyncExternalStore(
		(listener) => {
			window.addEventListener("online", listener);
			window.addEventListener("offline", listener);
			return () => {
				window.removeEventListener("online", listener);
				window.removeEventListener("offline", listener);
			};
		},
		() => navigator.onLine,
		() => true,
	);
}

export function useCaptureQueue() {
	const [queue, setQueue] = useState<CaptureQueue | null>(null);

	useEffect(() => {
		let cancelled = false;
		void openQueueStore().then(async ({ store, persistent }) => {
			if (cancelled) return;
			const next = createCaptureQueue({
				store,
				persistent,
				upload: xhrUpload,
				isOnline: () => navigator.onLine,
			});
			await next.load();
			if (cancelled) return;
			setQueue(next);
			void next.flush();
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!queue) return;
		const kick = () => void queue.flush();
		const onVisible = () => {
			if (document.visibilityState === "visible") kick();
		};
		window.addEventListener("online", kick);
		window.addEventListener("focus", kick);
		document.addEventListener("visibilitychange", onVisible);
		// Backoff timer: re-check every 10s whether something became due.
		const timer = window.setInterval(() => {
			const due = queue.nextDueAt();
			if (due !== null && due <= Date.now()) kick();
		}, 10_000);
		return () => {
			window.removeEventListener("online", kick);
			window.removeEventListener("focus", kick);
			document.removeEventListener("visibilitychange", onVisible);
			window.clearInterval(timer);
		};
	}, [queue]);

	const snapshot = useSyncExternalStore(
		queue?.subscribe ?? noopSubscribe,
		queue?.getSnapshot ?? emptySnapshot,
		emptySnapshot,
	);
	return { queue, snapshot };
}
