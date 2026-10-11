import { z } from "zod";
import { browser } from "wxt/browser";
import { SUPPORTED_STORE_IDS, type SupportedStoreId } from "./stores";

const storeTogglesSchema = z.object(
	Object.fromEntries(SUPPORTED_STORE_IDS.map((id) => [id, z.boolean().default(true)])) as Record<
		SupportedStoreId,
		z.ZodDefault<z.ZodBoolean>
	>,
);

export const settingsSchema = z.object({
	serverUrl: z.string().default(""),
	apiKey: z.string().default(""),
	/** Master switch for passive (automatic) capture while browsing. */
	passiveCapture: z.boolean().default(true),
	/** Per-store passive capture toggles. */
	stores: storeTogglesSchema.default(
		Object.fromEntries(SUPPORTED_STORE_IDS.map((id) => [id, true])) as Record<SupportedStoreId, boolean>,
	),
	/**
	 * Opt-in: detect order confirmation / order detail pages of common
	 * storefront platforms (Shopify, WooCommerce, …) on any other site and
	 * send them as HTML snapshots. Needs the optional all-sites host permission.
	 */
	autoDetectOrders: z.boolean().default(false),
	/** Capture every JSON response and every page on store domains (fixture collection). */
	recorderMode: z.boolean().default(false),
	/** Print HTML invoices to PDF with chrome.debugger (when the build includes the permission). */
	printInvoicesToPdf: z.boolean().default(true),
	/**
	 * Fetch order-detail pages the server asks for (orders it only knows
	 * partially, e.g. from an email) with your store session, in the background.
	 */
	fetchMissingDetails: z.boolean().default(true),
	/**
	 * Opt-in: when a fetched page renders client-side (AliExpress, DigiKey),
	 * open it in an inactive background tab so the content scripts capture it.
	 */
	fetchDetailsInTabs: z.boolean().default(false),
});
export type Settings = z.infer<typeof settingsSchema>;

export const SETTINGS_KEY = "settings";

export function parseSettings(raw: unknown): Settings {
	const parsed = settingsSchema.safeParse(raw ?? {});
	return parsed.success ? parsed.data : settingsSchema.parse({});
}

export function isConfigured(s: Settings): boolean {
	return s.serverUrl.length > 0 && s.apiKey.length > 0;
}

export async function getSettings(): Promise<Settings> {
	const got = await browser.storage.local.get(SETTINGS_KEY);
	return parseSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
	const current = await getSettings();
	const next = parseSettings({ ...current, ...patch, stores: { ...current.stores, ...(patch.stores ?? {}) } });
	await browser.storage.local.set({ [SETTINGS_KEY]: next });
	return next;
}
