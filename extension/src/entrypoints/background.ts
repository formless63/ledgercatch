import { type Browser, browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { getStatus, HttpError, lookupOrders } from "@/background/api";
import { ingestDetected, onPermissionsRemoved, syncDetector } from "@/background/detector";
import { refreshEnrichmentCount, runEnrichment } from "@/background/enrichment";
import { FLUSH_ALARM, flushOutbox, retryNow } from "@/background/flusher";
import { refreshSummary } from "@/background/history";
import { ingestCapture, ingestDocument } from "@/background/ingest";
import { runInvoiceJob, saveVisitedMouserInvoice } from "@/background/invoices";
import { clearMouserInvoiceOrders } from "@/background/mouser-invoices";
import { clearItems } from "@/background/outbox";
import { ENRICH_ALARM, ENRICH_PERIOD_MINUTES } from "@/lib/enrichment";
import { ENRICHMENT_DIAGNOSTIC_ALARM, readEnrichmentDiagnostic } from "@/lib/enrichment-diagnostics";
import { type BackgroundHandlers, isBackgroundMessage, type Result } from "@/lib/messaging";
import { getSettings, isConfigured } from "@/lib/settings";
import { getState, setState } from "@/lib/state";
import { base64ToBytes, errorMessage } from "@/lib/util";

const handlers: BackgroundHandlers = {
	"capture/submit": (draft) => ingestCapture(draft),

	"capture/detected": (draft) => ingestDetected(draft),

	"document/submit": async ({ meta, base64, contentType }) => {
		const id = await ingestDocument({
			meta,
			file: new Blob([base64ToBytes(base64)], { type: contentType || "application/octet-stream" }),
			label: meta.fileName,
		});
		return { queued: true, id };
	},

	"outbox/retry": async () => {
		await retryNow();
		return { flushed: true };
	},

	"outbox/clear": async ({ history }) => {
		const removed = await clearItems();
		if (history) {
			await setState("history", []);
			await setState("recentHashes", {});
			await setState("stats", { day: "", sent: 0 });
			await setState("invoiceJob", null);
			await setState("detectedUrls", {});
			await clearMouserInvoiceOrders();
		}
		await refreshSummary();
		return { removed };
	},

	"connection/test": async () => {
		const settings = await getSettings();
		const now = Date.now();
		try {
			const status = await getStatus(settings);
			await setState("authPaused", null);
			await setState("connection", {
				state: "ok",
				checkedAt: now,
				userName: status.user.name,
				userEmail: status.user.email,
				serverAppName: status.appName,
			});
			void flushOutbox();
			return status;
		} catch (err) {
			if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
				await setState("connection", { state: "auth_error", checkedAt: now, status: err.status, message: err.message });
			} else if (isConfigured(settings)) {
				await setState("connection", { state: "unreachable", checkedAt: now, message: errorMessage(err) });
			}
			throw err;
		}
	},

	"orders/lookup": async (input) => lookupOrders(await getSettings(), input),

	"invoices/save": async ({ tabId, source, pageUrl, candidates }) => ({
		jobId: await runInvoiceJob(tabId, source, pageUrl, candidates),
	}),

	"enrichment/run": () => runEnrichment("manual"),

	"enrichment/refresh": () => refreshEnrichmentCount(),

	"settings/changed": async () => {
		await clearMouserInvoiceOrders();
		const settings = await getSettings();
		await setState("authPaused", null);
		if (!isConfigured(settings)) await setState("connection", { state: "unconfigured" });
		await refreshSummary();
		await syncDetector();
		void flushOutbox();
		return null;
	},
};

function dispatch(message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> | null {
	if (!isBackgroundMessage(message)) return null;
	const handler = handlers[message.type] as
		| ((data: unknown, s: Browser.runtime.MessageSender) => Promise<unknown>)
		| undefined;
	if (!handler) return null;
	return handler(message.data, sender);
}

export default defineBackground({
	type: "module",
	main() {
		browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
			const pending = dispatch(message, sender);
			if (!pending) return false;
			pending.then(
				(data) => sendResponse({ ok: true, data } satisfies Result<unknown>),
				(err: unknown) => sendResponse({ ok: false, error: errorMessage(err) } satisfies Result<unknown>),
			);
			return true; // keep the channel open for the async response
		});

		browser.tabs.onUpdated.addListener((tabId, info, tab) => {
			if (info.status === "complete" && tab.url)
				void saveVisitedMouserInvoice(tabId, tab.url).catch((err) => {
					console.debug("[ledgercatch] PDF invoice capture failed:", errorMessage(err));
				});
		});

		browser.alarms.onAlarm.addListener((alarm) => {
			if (alarm.name === FLUSH_ALARM) void flushOutbox();
			if (alarm.name === ENRICH_ALARM) void runEnrichment("alarm").catch(() => {});
			if (alarm.name === ENRICHMENT_DIAGNOSTIC_ALARM) void readEnrichmentDiagnostic().catch(() => {});
		});

		const ensureAlarm = async () => {
			const existing = await browser.alarms.get(FLUSH_ALARM);
			if (!existing) await browser.alarms.create(FLUSH_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
			if (!(await browser.alarms.get(ENRICH_ALARM)))
				await browser.alarms.create(ENRICH_ALARM, { periodInMinutes: ENRICH_PERIOD_MINUTES, delayInMinutes: 2 });
		};

		browser.permissions.onAdded.addListener(() => {
			void syncDetector();
		});
		browser.permissions.onRemoved.addListener(() => {
			void onPermissionsRemoved();
		});

		browser.runtime.onInstalled.addListener((details) => {
			void ensureAlarm();
			void refreshSummary();
			// Updates replace the script file; re-register so the detector follows.
			void syncDetector();
			if (details.reason === "install") void browser.runtime.openOptionsPage();
		});
		browser.runtime.onStartup.addListener(() => {
			void ensureAlarm();
			void syncDetector();
			void flushOutbox();
		});

		void ensureAlarm();
		void (async () => {
			const settings = await getSettings();
			if (!isConfigured(settings)) await setState("connection", { state: "unconfigured" });
			await refreshSummary();
			// A worker killed mid-run leaves the flag set; this is a fresh worker.
			const enrichment = await getState("enrichment");
			if (enrichment.running) await setState("enrichment", { ...enrichment, running: false });
		})();
	},
});
