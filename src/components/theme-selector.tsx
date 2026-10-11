import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";
import { useEffect, useSyncExternalStore } from "react";
import { appearancePolicy } from "../appearance-policy";
import {
	type ColorPreference,
	preferenceSnapshot,
	serverPreferenceSnapshot,
	setPreference,
	subscribePreference,
} from "../lib/color-mode";

const subscribeHydration = () => () => {};
const clientReady = () => true;
const serverNotReady = () => false;

export function ThemeSelector() {
	const hydrated = useSyncExternalStore(
		subscribeHydration,
		clientReady,
		serverNotReady,
	);
	const preference = useSyncExternalStore(
		subscribePreference,
		preferenceSnapshot,
		serverPreferenceSnapshot,
	);
	if (!appearancePolicy.userSelectable || appearancePolicy.supported.length < 2)
		return null;
	const Icon =
		preference === "light"
			? IconSun
			: preference === "dark"
				? IconMoon
				: IconDeviceDesktop;
	return (
		<label className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm">
			<Icon size={18} aria-hidden="true" />
			<span className="sr-only">Color mode</span>
			<select
				className="bg-background text-foreground outline-offset-4"
				disabled={!hydrated}
				aria-label="Color mode"
				value={preference}
				onChange={(event) =>
					setPreference(event.target.value as ColorPreference)
				}
			>
				<option value="light">Light</option>
				<option value="dark">Dark</option>
				<option value="system">System</option>
			</select>
		</label>
	);
}

export function ColorModeSync() {
	useEffect(() => subscribePreference(() => {}), []);
	return null;
}
