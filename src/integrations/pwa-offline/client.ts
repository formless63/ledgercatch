import { pwaConfig, workerFilename } from "./config";
export interface PwaSnapshot {
	status:
		| "idle"
		| "unsupported"
		| "registering"
		| "ready"
		| "waiting"
		| "error";
	online: boolean;
	canInstall: boolean;
	installed: boolean;
	message: string;
}
interface InstallPrompt extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
const initial: PwaSnapshot = {
	status: "idle",
	online: true,
	canInstall: false,
	installed: false,
	message: "",
};
export function createPwaController() {
	let state = initial;
	let registration: ServiceWorkerRegistration | undefined;
	let pending: Promise<void> | undefined;
	let prompt: InstallPrompt | undefined;
	let cleanup: (() => void) | undefined;
	let removeRegistrationListeners: (() => void) | undefined;
	const listeners = new Set<() => void>();
	const emit = (patch: Partial<PwaSnapshot>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener();
	};
	const supported = () =>
		typeof window !== "undefined" &&
		window.isSecureContext &&
		"serviceWorker" in navigator;
	function watch(next: ServiceWorkerRegistration) {
		removeRegistrationListeners?.();
		registration = next;
		if (!listeners.size) return;
		let installing: ServiceWorker | null = null;
		const sync = () =>
			emit({
				status: next.waiting
					? "waiting"
					: next.active
						? "ready"
						: installing?.state === "redundant"
							? "error"
							: "registering",
				message: next.waiting
					? "An update is waiting. Save your work and close all tabs for this site when convenient."
					: "",
			});
		const found = () => {
			installing?.removeEventListener("statechange", sync);
			installing = next.installing;
			installing?.addEventListener("statechange", sync);
			sync();
		};
		next.addEventListener("updatefound", found);
		found();
		removeRegistrationListeners = () => {
			next.removeEventListener("updatefound", found);
			installing?.removeEventListener("statechange", sync);
		};
	}
	function attach() {
		if (!supported()) {
			emit({
				status: "unsupported",
				message: "A secure browser with service-worker support is required.",
			});
			return;
		}
		const online = () => emit({ online: navigator.onLine });
		const install = (event: Event) => {
			if (!event.isTrusted) return;
			event.preventDefault();
			prompt = event as InstallPrompt;
			emit({ canInstall: true });
		};
		const installed = (event: Event) => {
			if (!event.isTrusted) return;
			prompt = undefined;
			emit({
				canInstall: false,
				installed: true,
				message: "The browser reported installation.",
			});
		};
		window.addEventListener("online", online);
		window.addEventListener("offline", online);
		window.addEventListener("beforeinstallprompt", install);
		window.addEventListener("appinstalled", installed);
		online();
		if (registration) watch(registration);
		cleanup = () => {
			window.removeEventListener("online", online);
			window.removeEventListener("offline", online);
			window.removeEventListener("beforeinstallprompt", install);
			window.removeEventListener("appinstalled", installed);
			removeRegistrationListeners?.();
			prompt = undefined;
			state = { ...state, canInstall: false };
		};
	}
	return {
		getSnapshot: () => state,
		getServerSnapshot: () => initial,
		subscribe(listener: () => void) {
			listeners.add(listener);
			if (listeners.size === 1) attach();
			return () => {
				listeners.delete(listener);
				if (!listeners.size) {
					cleanup?.();
					cleanup = undefined;
				}
			};
		},
		register() {
			if (!supported() || pwaConfig.retired) return Promise.resolve();
			if (pending) return pending;
			emit({ status: "registering", message: "" });
			pending = (async () => {
				const scope = new URL(pwaConfig.base, location.origin);
				const script = new URL(workerFilename, scope).href;
				for (const existing of await navigator.serviceWorker.getRegistrations()) {
					if (
						!(
							scope.href.startsWith(existing.scope) ||
							existing.scope.startsWith(scope.href)
						)
					)
						continue;
					if (
						existing.scope !== scope.href ||
						[existing.active, existing.waiting, existing.installing].some(
							(worker) => worker && worker.scriptURL !== script,
						)
					)
						throw new Error("conflict");
				}
				if (
					navigator.serviceWorker.controller &&
					navigator.serviceWorker.controller.scriptURL !== script
				)
					throw new Error("conflict");
				const next = await navigator.serviceWorker.register(script, {
					scope: pwaConfig.base,
					updateViaCache: "none",
				});
				watch(next);
			})()
				.catch(() =>
					emit({
						status: "error",
						message:
							"Offline support could not start. Check the connection, deployment and existing worker ownership.",
					}),
				)
				.finally(() => {
					pending = undefined;
				});
			return pending;
		},
		async checkUpdate() {
			try {
				await registration?.update();
			} catch {
				emit({ message: "Update check failed. Current tabs are unchanged." });
			}
		},
		later() {
			emit({ message: "" });
		},
		async install() {
			const event = prompt;
			if (!event) return;
			// Called directly by a user gesture; never simulate installation.
			prompt = undefined;
			emit({ canInstall: false });
			try {
				await event.prompt();
				const choice = await event.userChoice;
				emit({
					message:
						choice.outcome === "accepted"
							? "Install request accepted by the browser."
							: "Installation dismissed.",
				});
			} catch {
				emit({ message: "Installation was not completed." });
			}
		},
	};
}
let controller: ReturnType<typeof createPwaController> | undefined;
export function getPwaController() {
	if (!controller) controller = createPwaController();
	return controller;
}
