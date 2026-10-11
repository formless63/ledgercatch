import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { SETTINGS_KEY, type Settings, parseSettings } from "@/lib/settings";
import { STATE_DEFAULTS, type StateKey, type StateShape } from "@/lib/state";

/** Live view of a chrome.storage.local state key. */
export function useStoredState<K extends StateKey>(key: K): StateShape[K] {
	const [value, setValue] = useState<StateShape[K]>(STATE_DEFAULTS[key]);
	useEffect(() => {
		let alive = true;
		browser.storage.local.get(key).then((got) => {
			if (alive) setValue((got[key] as StateShape[K] | undefined) ?? STATE_DEFAULTS[key]);
		});
		const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
			if (area === "local" && key in changes) {
				setValue((changes[key]?.newValue as StateShape[K] | undefined) ?? STATE_DEFAULTS[key]);
			}
		};
		browser.storage.onChanged.addListener(listener);
		return () => {
			alive = false;
			browser.storage.onChanged.removeListener(listener);
		};
	}, [key]);
	return value;
}

/** Live settings; `null` until loaded. */
export function useSettings(): Settings | null {
	const [value, setValue] = useState<Settings | null>(null);
	useEffect(() => {
		let alive = true;
		browser.storage.local.get(SETTINGS_KEY).then((got) => {
			if (alive) setValue(parseSettings(got[SETTINGS_KEY]));
		});
		const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
			if (area === "local" && SETTINGS_KEY in changes) setValue(parseSettings(changes[SETTINGS_KEY]?.newValue));
		};
		browser.storage.onChanged.addListener(listener);
		return () => {
			alive = false;
			browser.storage.onChanged.removeListener(listener);
		};
	}, []);
	return value;
}

export function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(t);
	}, [intervalMs]);
	return now;
}
