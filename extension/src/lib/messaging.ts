/**
 * Typed request/response messaging between extension contexts and the
 * service worker. Every message is `{ type, data }`; every response is a
 * `Result` so errors cross the boundary as values, not as lost exceptions.
 */
import type { DocumentUploadMeta, ExtensionStatus, OrderLookupResponse, StoreId } from "@app/shared/capture";
import { type Browser, browser } from "wxt/browser";
import type { CaptureDraft } from "./envelope";
import type { EnrichmentRunSummary } from "./state";
import type { InvoiceCandidate } from "./stores";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type SubmitOutcome =
	| { status: "queued"; captureId: string }
	| { status: "skipped"; reason: "duplicate" | "disabled" | "unconfigured" }
	| { status: "invalid"; error: string };

export interface BackgroundProtocol {
	/** Content script / popup -> queue a capture. */
	"capture/submit": { req: CaptureDraft; res: SubmitOutcome };
	/**
	 * Auto-detect content script -> queue a platform order page snapshot.
	 * The background re-checks the opt-in, exclusions and "once per URL".
	 */
	"capture/detected": { req: CaptureDraft; res: SubmitOutcome };
	/** Queue a binary document for upload. `base64` is the file body. */
	"document/submit": {
		req: { meta: DocumentUploadMeta; base64: string; contentType: string };
		res: { queued: true; id: string };
	};
	"outbox/retry": { req: null; res: { flushed: boolean } };
	"outbox/clear": { req: { history: boolean }; res: { removed: number } };
	"connection/test": { req: null; res: ExtensionStatus };
	"orders/lookup": { req: { source: StoreId; externalOrderIds: string[] }; res: OrderLookupResponse };
	"invoices/save": {
		req: { tabId: number; source: StoreId; pageUrl: string; candidates: InvoiceCandidate[] };
		res: { jobId: string };
	};
	/** Popup: fetch missing order details now (background enrichment). */
	"enrichment/run": { req: null; res: EnrichmentRunSummary };
	/** Popup: refresh the server's pending enrichment count. */
	"enrichment/refresh": { req: null; res: { pending: number } };
	/** Settings changed (from options page). Re-evaluate badge / pause state. */
	"settings/changed": { req: null; res: null };
}

export type BackgroundMessageType = keyof BackgroundProtocol;

export interface BackgroundMessage<K extends BackgroundMessageType = BackgroundMessageType> {
	ns: typeof MESSAGE_NS;
	type: K;
	data: BackgroundProtocol[K]["req"];
}

export const MESSAGE_NS = "ledgercatch@1" as const;

export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { ns?: unknown }).ns === MESSAGE_NS &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

export async function sendToBackground<K extends BackgroundMessageType>(
	type: K,
	data: BackgroundProtocol[K]["req"],
): Promise<BackgroundProtocol[K]["res"]> {
	const message: BackgroundMessage<K> = { ns: MESSAGE_NS, type, data };
	const response = (await browser.runtime.sendMessage(message)) as Result<BackgroundProtocol[K]["res"]> | undefined;
	if (!response) throw new Error("No response from background (service worker not running?)");
	if (!response.ok) throw new Error(response.error);
	return response.data;
}

export type BackgroundHandlers = {
	[K in BackgroundMessageType]: (
		data: BackgroundProtocol[K]["req"],
		sender: Browser.runtime.MessageSender,
	) => Promise<BackgroundProtocol[K]["res"]>;
};
