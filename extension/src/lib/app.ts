import { browser } from "wxt/browser";
import { DEFAULT_APP_NAME } from "./app-name";

/** Product name as baked into the manifest at build time (EXT_APP_NAME). */
export function appName(): string {
	try {
		return browser.runtime.getManifest().name || DEFAULT_APP_NAME;
	} catch {
		return DEFAULT_APP_NAME;
	}
}

export function extensionVersion(): string {
	try {
		return browser.runtime.getManifest().version;
	} catch {
		return "0.0.0";
	}
}
