import { appearancePolicy } from "../appearance-policy";

export type ColorPreference = "light" | "dark" | "system";
export interface ColorPolicy {
	supported: readonly ("light" | "dark")[];
	default: ColorPreference;
	userSelectable: boolean;
}
export function validPreference(
	value: unknown,
	policy: ColorPolicy = appearancePolicy,
): value is ColorPreference {
	return (
		(value === "system" && policy.supported.length === 2) ||
		((value === "light" || value === "dark") &&
			policy.supported.includes(value))
	);
}
export function resolvePreference(
	value: unknown,
	policy: ColorPolicy = appearancePolicy,
): ColorPreference {
	return policy.userSelectable && validPreference(value, policy)
		? value
		: policy.default;
}
export function resolvedMode(
	preference: ColorPreference,
	systemDark: boolean,
): "light" | "dark" {
	return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
let temporaryPreference: ColorPreference | undefined;
function preference(): ColorPreference {
	if (typeof window === "undefined") return appearancePolicy.default;
	if (temporaryPreference !== undefined)
		return resolvePreference(temporaryPreference);
	try {
		return resolvePreference(localStorage.getItem("theme"));
	} catch {
		return appearancePolicy.default;
	}
}
function apply() {
	const mode = resolvedMode(
		preference(),
		window.matchMedia("(prefers-color-scheme: dark)").matches,
	);
	document.documentElement.classList.toggle("dark", mode === "dark");
	document.documentElement.style.colorScheme = mode;
}
export function setPreference(value: ColorPreference) {
	if (!appearancePolicy.userSelectable || !validPreference(value)) return;
	temporaryPreference = value;
	try {
		localStorage.setItem("theme", value);
	} catch {
		/* Selection still works in this tab when storage is unavailable. */
	}
	apply();
	window.dispatchEvent(new Event("color-mode-change"));
}
export function subscribePreference(listener: () => void): () => void {
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	const changed = () => {
		apply();
		listener();
	};
	const stored = (event: StorageEvent) => {
		if (event.key === "theme" || event.key === null) {
			temporaryPreference = undefined;
			changed();
		}
	};
	window.addEventListener("storage", stored);
	window.addEventListener("color-mode-change", changed);
	media.addEventListener("change", changed);
	apply();
	return () => {
		window.removeEventListener("storage", stored);
		window.removeEventListener("color-mode-change", changed);
		media.removeEventListener("change", changed);
	};
}
export const preferenceSnapshot = preference;
export const serverPreferenceSnapshot = () => appearancePolicy.default;

// Trusted generated policy only; run in <head> before stylesheet/content paint.
// React hydrates controls with the deterministic server snapshot, then subscribes.
export function initialColorModeScript(
	policy: ColorPolicy = appearancePolicy,
): string {
	return `(()=>{const p=${JSON.stringify(policy)};let v=p.default;try{const s=localStorage.getItem('theme');if(p.userSelectable&&((s==='system'&&p.supported.length===2)||p.supported.includes(s)))v=s}catch{}const d=v==='dark'||(v==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'})()`;
}
