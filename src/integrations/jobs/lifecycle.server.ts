import type { PgBoss } from "pg-boss";

// Jobs-specific lifecycle: share startup, recover failure, serialize stop/restart.
export function createJobsLifecycle<T extends Pick<PgBoss, "start" | "stop">>(
	create: () => T,
	prepare: (boss: T) => Promise<void>,
) {
	let pending: Promise<T> | undefined;
	let stopping: Promise<void> | undefined;
	async function get(): Promise<T> {
		if (stopping) await stopping;
		if (!pending) {
			const initialization = (async () => {
				const boss = create();
				try {
					await boss.start();
					await prepare(boss);
					return boss;
				} catch (error) {
					await boss.stop({ graceful: false, timeout: 10_000 }).catch(() => {});
					throw error;
				}
			})();
			pending = initialization;
			void initialization.catch(() => {
				if (pending === initialization) pending = undefined;
			});
		}
		return pending;
	}
	function stop(): Promise<void> {
		if (stopping) return stopping;
		const previous = pending;
		pending = undefined;
		stopping = (async () => {
			const boss = await previous?.catch(() => undefined);
			await boss?.stop({ graceful: true, timeout: 10_000 });
		})().finally(() => {
			stopping = undefined;
		});
		return stopping;
	}
	return { get, stop };
}
