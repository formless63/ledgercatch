/**
 * Resolve once the DOM has been quiet (no mutations) for `quietMs`, or after
 * `maxMs` regardless. Rejects with "aborted" when the signal fires.
 */
export function waitForDomSettle(opts: { quietMs: number; maxMs: number; signal?: AbortSignal }): Promise<void> {
	return new Promise((resolve, reject) => {
		const root = document.documentElement;
		let quietTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => {
			observer.disconnect();
			clearTimeout(quietTimer);
			clearTimeout(maxTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			ok ? resolve() : reject(new Error("aborted"));
		};
		const onAbort = () => finish(false);
		const bump = () => {
			clearTimeout(quietTimer);
			quietTimer = setTimeout(() => finish(true), opts.quietMs);
		};
		const observer = new MutationObserver(bump);
		observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: false });
		const maxTimer = setTimeout(() => finish(true), opts.maxMs);
		if (opts.signal?.aborted) return finish(false);
		opts.signal?.addEventListener("abort", onAbort);
		bump();
	});
}

export function domReady(): Promise<void> {
	if (document.readyState !== "loading") return Promise.resolve();
	return new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
}
