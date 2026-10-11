/**
 * Opt-in auto-detection of storefront order pages on other sites.
 *
 * The detector content script (`order-detector.content.ts`) is never in the
 * manifest. It is registered with `scripting.registerContentScripts` only
 * while the setting is on AND the optional all-sites host permission is
 * granted, and unregistered otherwise.
 */
import { browser } from "wxt/browser";
import type { CaptureDraft } from "@/lib/envelope";
import type { SubmitOutcome } from "@/lib/messaging";
import {
	ALL_SITES_PATTERNS,
	detectorExcludeMatches,
	detectorUrlKey,
	isExcludedUrl,
} from "@/lib/order-detector";
import { getSettings, isConfigured, saveSettings } from "@/lib/settings";
import { getState, setState } from "@/lib/state";
import { serialized } from "./history";
import { ingestCapture } from "./ingest";

export const DETECTOR_SCRIPT_ID = "ledgercatch-order-detector";
/** WXT output path of `entrypoints/order-detector.content.ts`. */
export const DETECTOR_SCRIPT_FILE = "content-scripts/order-detector.js";

/** "Once per URL" memory: keep 90 days, at most 2000 URLs. */
const DETECTED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DETECTED_MAX = 2000;

export function hasAllSitesPermission(): Promise<boolean> {
	return browser.permissions.contains({ origins: ALL_SITES_PATTERNS }).catch(() => false);
}

/** Register / update / unregister the detector to match settings + permission. */
export async function syncDetector(): Promise<void> {
	const settings = await getSettings();
	const granted = await hasAllSitesPermission();
	const want = settings.autoDetectOrders && settings.passiveCapture && isConfigured(settings) && granted;
	let existing: { id: string }[] = [];
	try {
		existing = await browser.scripting.getRegisteredContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
	} catch {
		existing = [];
	}
	try {
		if (!want) {
			if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
			return;
		}
		const script = {
			id: DETECTOR_SCRIPT_ID,
			js: [DETECTOR_SCRIPT_FILE],
			matches: ALL_SITES_PATTERNS,
			excludeMatches: detectorExcludeMatches(settings.serverUrl),
			runAt: "document_idle" as const,
			allFrames: false,
			persistAcrossSessions: true,
		};
		if (existing.length > 0) await browser.scripting.updateContentScripts([script]);
		else await browser.scripting.registerContentScripts([script]);
	} catch (err) {
		console.warn("[ledgercatch] detector registration failed:", err);
	}
}

/** The user revoked the all-sites permission: turn the feature off. */
export async function onPermissionsRemoved(): Promise<void> {
	const settings = await getSettings();
	if (settings.autoDetectOrders && !(await hasAllSitesPermission())) {
		await saveSettings({ autoDetectOrders: false });
	}
	await syncDetector();
}

function pruneDetected(map: Record<string, number>, now: number): Record<string, number> {
	return Object.fromEntries(
		Object.entries(map)
			.filter(([, ts]) => now - ts < DETECTED_TTL_MS)
			.sort((a, b) => b[1] - a[1])
			.slice(0, DETECTED_MAX),
	);
}

/** Handler for "capture/detected": validate, apply opt-in + once-per-URL, queue. */
export async function ingestDetected(draft: CaptureDraft): Promise<SubmitOutcome> {
	const settings = await getSettings();
	if (!isConfigured(settings)) return { status: "skipped", reason: "unconfigured" };
	if (!settings.autoDetectOrders || !settings.passiveCapture) return { status: "skipped", reason: "disabled" };
	if (
		draft.source !== "generic" ||
		draft.trigger !== "passive" ||
		draft.kind !== "html_snapshot" ||
		(draft.pageType !== "order_confirmation" && draft.pageType !== "order_detail")
	) {
		return { status: "invalid", error: "unexpected auto-detected capture" };
	}
	if (isExcludedUrl(draft.pageUrl, settings.serverUrl)) return { status: "skipped", reason: "disabled" };
	const key = detectorUrlKey(draft.pageUrl);
	const first = await serialized(async () => {
		const now = Date.now();
		const map = await getState("detectedUrls");
		if (map[key] !== undefined && now - map[key] < DETECTED_TTL_MS) return false;
		await setState("detectedUrls", pruneDetected({ ...map, [key]: now }, now));
		return true;
	});
	if (!first) return { status: "skipped", reason: "duplicate" };
	return ingestCapture(draft);
}
