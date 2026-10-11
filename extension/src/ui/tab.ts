/** Popup-side helpers that act on the active tab (activeTab + scripting). */
import { MAX_HTML_BYTES, MAX_SCREENSHOT_BYTES, MAX_TEXT_BYTES, type PageType, type StoreId } from "@app/shared/capture";
import { browser } from "wxt/browser";
import { captureHtml, shrinkHtml } from "@/lib/html";
import { type SubmitOutcome, sendToBackground } from "@/lib/messaging";
import { type PageProbe, grabHtml, probePage } from "@/lib/page-probes";
import {
	type InvoiceCandidate,
	type StoreDefinition,
	classifyUrl,
	extractOrderIdHints,
	findInvoiceCandidates,
} from "@/lib/stores";

const MAX_LINKS = 3_000;
/** DOM sent along with "Track this page" (after stripping scripts/styles). */
const TRACK_PAGE_MAX_HTML_BYTES = 2 * 1024 * 1024;

export interface TabContext {
	tabId: number;
	windowId: number;
	url: string;
	title: string;
	source: StoreId;
	store: StoreDefinition | null;
	pageType: PageType;
	/** Could we run a script in the page (false on chrome://, Web Store, PDFs...). */
	scriptable: boolean;
	orderIds: string[];
	invoices: InvoiceCandidate[];
}

export async function activeTab(): Promise<{ id: number; windowId: number; url: string; title: string } | null> {
	const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id || !tab.url) return null;
	return { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title ?? "" };
}

async function probe(tabId: number, store: StoreDefinition | null, maxText: number): Promise<PageProbe | null> {
	try {
		const [res] = await browser.scripting.executeScript({
			target: { tabId },
			func: probePage,
			args: [maxText, MAX_LINKS, store?.orderIds.dom?.selectors ?? []],
		});
		return (res?.result as PageProbe | undefined) ?? null;
	} catch {
		return null;
	}
}

export async function inspectActiveTab(): Promise<TabContext | null> {
	const tab = await activeTab();
	if (!tab) return null;
	const { source, store, pageType } = classifyUrl(tab.url);
	const base: TabContext = {
		tabId: tab.id,
		windowId: tab.windowId,
		url: tab.url,
		title: tab.title,
		source,
		store,
		pageType,
		scriptable: false,
		orderIds: [],
		invoices: [],
	};
	if (!/^https?:/.test(tab.url)) return base;
	const page = await probe(tab.id, store, 2_000_000);
	if (!page) return base;
	const orderIds = extractOrderIdHints(store, {
		urls: [page.url, ...page.links.map((l) => l.href)],
		text: page.text,
		domText: page.domText,
	});
	let invoices = store ? findInvoiceCandidates(store, page.links, orderIds) : [];
	const pageIsReceipt = pageType === "invoice" || (pageType === "order_detail" && store?.detailIsReceipt);
	if (store && pageIsReceipt && !invoices.some((c) => c.url === page.url)) {
		invoices = [
			{ url: page.url, label: "This page", format: "html", externalOrderId: orderIds.length === 1 ? orderIds[0] : undefined },
			...invoices,
		];
	}
	return { ...base, url: page.url, title: page.title || tab.title, scriptable: true, orderIds, invoices };
}

/** JPEG of the visible viewport, shrunk until it fits the contract limit. */
export async function screenshot(windowId: number): Promise<string | undefined> {
	const limit = Math.floor(MAX_SCREENSHOT_BYTES * 1.33);
	for (const quality of [70, 50, 35]) {
		try {
			const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: "jpeg", quality });
			if (dataUrl.length <= limit) return dataUrl;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export async function trackPage(ctx: TabContext, note: string, withScreenshot: boolean): Promise<SubmitOutcome> {
	const page = await probe(ctx.tabId, ctx.store, MAX_TEXT_BYTES);
	if (!page) throw new Error("This page can't be read by extensions (browser or store-protected page).");
	const shot = withScreenshot ? await screenshot(ctx.windowId) : undefined;
	const html = await pageHtml(ctx.tabId);
	return sendToBackground("capture/submit", {
		source: ctx.source,
		kind: "page_text",
		trigger: "manual",
		pageType: ctx.pageType,
		pageUrl: page.url,
		pageTitle: page.title,
		orderIdHints: ctx.orderIds,
		payload: {
			type: "text",
			text: page.text,
			screenshotDataUrl: shot,
			note: note.trim() || undefined,
			html,
		},
	});
}

/**
 * The page DOM for "Track this page", so the server can try deterministic
 * platform parsers before AI. Scripts are emptied except JSON-LD and known
 * order-data globals; best effort (undefined when the page can't be read).
 */
async function pageHtml(tabId: number): Promise<string | undefined> {
	try {
		const [res] = await browser.scripting.executeScript({ target: { tabId }, func: grabHtml });
		const grabbed = res?.result as ReturnType<typeof grabHtml> | undefined;
		return grabbed ? captureHtml(grabbed.html, TRACK_PAGE_MAX_HTML_BYTES) : undefined;
	} catch {
		return undefined;
	}
}

export async function snapshotHtml(ctx: TabContext): Promise<SubmitOutcome> {
	const [res] = await browser.scripting.executeScript({ target: { tabId: ctx.tabId }, func: grabHtml });
	const grabbed = res?.result as ReturnType<typeof grabHtml> | undefined;
	if (!grabbed) throw new Error("Could not read the page HTML.");
	return sendToBackground("capture/submit", {
		source: ctx.source,
		kind: "html_snapshot",
		trigger: "manual",
		pageType: ctx.pageType,
		pageUrl: grabbed.url,
		pageTitle: grabbed.title,
		orderIdHints: ctx.orderIds,
		payload: { type: "html", html: shrinkHtml(grabbed.html, MAX_HTML_BYTES) },
	});
}

/** True when this build has the `debugger` permission (PDF printing of HTML invoices). */
export function canPrintToPdf(): Promise<boolean> {
	return browser.permissions.contains({ permissions: ["debugger"] }).catch(() => false);
}

export function describeOutcome(outcome: SubmitOutcome): { tone: "ok" | "warn" | "bad"; text: string } {
	switch (outcome.status) {
		case "queued":
			return { tone: "ok", text: "Queued for upload" };
		case "skipped":
			return {
				tone: "warn",
				text:
					outcome.reason === "duplicate"
						? "Already sent in the last 24h"
						: outcome.reason === "disabled"
							? "Capture disabled for this store"
							: "Server not configured",
			};
		case "invalid":
			return { tone: "bad", text: `Rejected: ${outcome.error.slice(0, 120)}` };
	}
}
