import { useEffect, useState, useSyncExternalStore } from "react";
import { getPwaController } from "./client";
export function PwaPanel() {
	const controller = getPwaController();
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot,
	);
	const [hydrated, setHydrated] = useState(false);
	useEffect(() => setHydrated(true), []);
	return (
		<section aria-label="Offline support">
			<h2>Public offline support</h2>
			<p>
				Only a public offline notice and public icons are stored. Account pages,
				API data and drafts are never saved by this worker.
			</p>
			<output>
				{state.online ? "Connection available" : "Connection unavailable"} ·{" "}
				{state.status}
			</output>
			<button
				type="button"
				disabled={
					!hydrated ||
					state.status === "unsupported" ||
					state.status === "registering"
				}
				onClick={() => void controller.register()}
			>
				Enable offline notice
			</button>
			<button
				type="button"
				disabled={!hydrated || !["ready", "waiting"].includes(state.status)}
				onClick={() => void controller.checkUpdate()}
			>
				Check for updates
			</button>
			<button
				type="button"
				disabled={!hydrated || !state.canInstall}
				onClick={() => void controller.install()}
			>
				Install app
			</button>
			<p>
				Installation is offered only when your browser supports it and considers
				this app eligible. You can also check its menu.
			</p>
			{state.message && (
				<div>
					<output>{state.message}</output>
					{state.status === "waiting" && (
						<button type="button" onClick={() => controller.later()}>
							Later
						</button>
					)}
				</div>
			)}
		</section>
	);
}
