/**
 * "Save invoices on this page".
 *
 * For each candidate link:
 *  1. Fetch it from inside the store tab (same-origin cookies). A PDF/binary is
 *     uploaded to /api/v1/documents. An "index" (e.g. Amazon's invoice popover)
 *     is expanded into the links it contains.
 *  2. An HTML invoice is opened in a background tab. Builds made with
 *     EXT_DEBUGGER_PERMISSION=required print it to PDF with chrome.debugger
 *     (Page.printToPDF) and upload the PDF.
 *  3. Default (no debugger permission) or print failure: upload the page's
 *     HTML as a document (kind invoice, content-type text/html; the app
 *     serves it as plain text) and also queue an html_snapshot capture with
 *     pageType "invoice" so the server parsers see its order data.
 */
import { type DocumentKind, MAX_DOCUMENT_BYTES, MAX_HTML_BYTES, type StoreId } from "@app/shared/capture";
import { browser } from "wxt/browser";
import { isRecentDuplicate, rememberHash } from "@/lib/dedupe";
import { invoiceDocumentHtml, shrinkHtml } from "@/lib/html";
import { mouserPdfInvoiceNumber } from "@/lib/mouser-invoices";
import { type FetchProbeResult, fetchFromPage, grabHtml } from "@/lib/page-probes";
import { getSettings, isConfigured } from "@/lib/settings";
import { getState, type InvoiceJob, type InvoiceJobItem, setState } from "@/lib/state";
import {
	classifyUrl,
	extractOrderIdHints,
	findInvoiceCandidates,
	type InvoiceCandidate,
	storeForUrl,
} from "@/lib/stores";
import { arrayBufferToBase64, base64ToBytes, delay, errorMessage, safeFileName, sha256Hex } from "@/lib/util";
import { serialized } from "./history";
import { ingestCapture, ingestDocument } from "./ingest";
import { orderForMouserInvoice } from "./mouser-invoices";

const TAB_LOAD_TIMEOUT_MS = 45_000;
const PRINT_SETTLE_MS = 2_000;
const MAX_INVOICES_PER_JOB = 50;

function updateJob(jobId: string, mutate: (job: InvoiceJob) => InvoiceJob): Promise<void> {
	return serialized(async () => {
		const job = await getState("invoiceJob");
		if (!job || job.id !== jobId) return;
		await setState("invoiceJob", mutate(job));
	});
}

function setItem(jobId: string, index: number, patch: Partial<InvoiceJobItem>): Promise<void> {
	return updateJob(jobId, (job) => ({
		...job,
		items: job.items.map((it, i) => (i === index ? { ...it, ...patch } : it)),
	}));
}

async function fetchInTab(tabId: number, url: string): Promise<FetchProbeResult> {
	try {
		const [res] = await browser.scripting.executeScript({
			target: { tabId },
			func: fetchFromPage,
			args: [url, MAX_DOCUMENT_BYTES],
		});
		return (res?.result as FetchProbeResult | undefined) ?? { ok: false, status: 0, error: "no result from tab" };
	} catch (err) {
		return { ok: false, status: 0, error: errorMessage(err) };
	}
}

/**
 * Fallback for cross-origin links (e.g. presigned redirects): the service
 * worker has host permissions for store domains, so it can fetch with the
 * user's cookies without CORS. Only binaries are accepted here.
 */
async function fetchInWorker(url: string): Promise<FetchProbeResult> {
	try {
		const res = await fetch(url, { credentials: "include", redirect: "follow" });
		if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		if (contentType.includes("html")) return { ok: false, status: res.status, error: "HTML response" };
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_DOCUMENT_BYTES) return { ok: false, status: res.status, error: "file too large" };
		const disposition = res.headers.get("content-disposition") ?? "";
		const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
		return {
			ok: true,
			status: res.status,
			finalUrl: res.url || url,
			contentType: contentType || "application/octet-stream",
			kind: "binary",
			base64: arrayBufferToBase64(buf),
			size: buf.byteLength,
			fileName: nameMatch?.[1] ? decodeURIComponent(nameMatch[1]) : null,
		};
	} catch (err) {
		return { ok: false, status: 0, error: errorMessage(err) };
	}
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			browser.tabs.onUpdated.removeListener(listener);
			reject(new Error("timed out loading invoice page"));
		}, timeoutMs);
		const listener = (id: number, info: { status?: string }) => {
			if (id === tabId && info.status === "complete") {
				clearTimeout(timer);
				browser.tabs.onUpdated.removeListener(listener);
				resolve();
			}
		};
		browser.tabs.onUpdated.addListener(listener);
		browser.tabs
			.get(tabId)
			.then((tab) => {
				if (tab.status === "complete") listener(tabId, { status: "complete" });
			})
			.catch(() => {});
	});
}

export async function hasDebuggerPermission(): Promise<boolean> {
	try {
		return await browser.permissions.contains({ permissions: ["debugger"] });
	} catch {
		return false;
	}
}

async function printTabToPdf(tabId: number): Promise<Uint8Array<ArrayBuffer>> {
	const target = { tabId };
	await browser.debugger.attach(target, "1.3");
	try {
		const result = (await browser.debugger.sendCommand(target, "Page.printToPDF", {
			printBackground: true,
			preferCSSPageSize: true,
		})) as { data?: string } | undefined;
		if (!result?.data) throw new Error("printToPDF returned no data");
		return base64ToBytes(result.data);
	} finally {
		await browser.debugger.detach(target).catch(() => {});
	}
}

interface HandleContext {
	source: StoreId;
	pageUrl: string;
	canPrint: boolean;
}

/** Open the invoice page in a background tab; print it to PDF or snapshot its HTML. */
async function captureHtmlInvoice(candidate: InvoiceCandidate, ctx: HandleContext): Promise<"uploaded" | "snapshot"> {
	const tab = await browser.tabs.create({ url: candidate.url, active: false });
	const tabId = tab.id;
	if (tabId === undefined) throw new Error("could not open invoice tab");
	try {
		await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
		await delay(PRINT_SETTLE_MS);
		const loaded = await browser.tabs.get(tabId);
		const finalUrl = loaded.url || candidate.url;
		if (ctx.canPrint) {
			try {
				const pdf = await printTabToPdf(tabId);
				if (pdf.byteLength > MAX_DOCUMENT_BYTES) throw new Error("printed PDF too large");
				await ingestDocument({
					meta: {
						source: ctx.source,
						kind: "invoice",
						externalOrderId: candidate.externalOrderId,
						originUrl: finalUrl,
						fileName: safeFileName(`${ctx.source}-${candidate.externalOrderId ?? "invoice"}.pdf`),
					},
					file: new Blob([pdf], { type: "application/pdf" }),
					label: candidate.label,
				});
				return "uploaded";
			} catch (err) {
				console.warn("[ledgercatch] printToPDF failed, falling back to HTML snapshot:", err);
			}
		}
		const [res] = await browser.scripting.executeScript({ target: { tabId }, func: grabHtml });
		const grabbed = res?.result as ReturnType<typeof grabHtml> | undefined;
		if (!grabbed) throw new Error("could not read invoice page");
		const store = storeForUrl(grabbed.url);
		const orderIdHints = [
			...(candidate.externalOrderId ? [candidate.externalOrderId] : []),
			...extractOrderIdHints(store, { urls: [grabbed.url] }),
		];
		let documentQueued = false;
		try {
			const html = invoiceDocumentHtml(grabbed.html, Math.min(MAX_HTML_BYTES, MAX_DOCUMENT_BYTES));
			await ingestDocument({
				meta: {
					source: ctx.source,
					kind: "invoice",
					externalOrderId: candidate.externalOrderId ?? orderIdHints[0],
					originUrl: grabbed.url,
					fileName: safeFileName(`${ctx.source}-${candidate.externalOrderId ?? "invoice"}.html`),
				},
				file: new Blob([html], { type: "text/html" }),
				label: candidate.label,
			});
			documentQueued = true;
		} catch (err) {
			console.warn("[ledgercatch] HTML invoice document upload failed, sending snapshot only:", err);
		}
		const outcome = await ingestCapture({
			source: ctx.source,
			kind: "html_snapshot",
			trigger: "manual",
			pageType: "invoice",
			pageUrl: grabbed.url,
			pageTitle: grabbed.title,
			orderIdHints,
			payload: { type: "html", html: shrinkHtml(grabbed.html, MAX_HTML_BYTES) },
		});
		if (outcome.status === "invalid" && !documentQueued) throw new Error(outcome.error);
		return documentQueued ? "uploaded" : "snapshot";
	} finally {
		await browser.tabs.remove(tabId).catch(() => {});
	}
}

function fileNameFor(
	candidate: InvoiceCandidate,
	source: StoreId,
	probe: { fileName: string | null; contentType: string; finalUrl: string },
): string {
	if (probe.fileName) return safeFileName(probe.fileName);
	const ext = probe.contentType.includes("pdf")
		? "pdf"
		: (probe.finalUrl.split(/[?#]/)[0]?.split(".").pop() ?? "bin").slice(0, 5);
	return safeFileName(`${source}-${candidate.externalOrderId ?? "invoice"}.${ext}`);
}

async function handleCandidate(
	tabId: number,
	candidate: InvoiceCandidate,
	ctx: HandleContext,
	documentKind: DocumentKind,
	expand: (found: InvoiceCandidate[]) => void,
): Promise<InvoiceJobItem["status"]> {
	if (candidate.format === "html") return captureHtmlInvoice(candidate, ctx);

	let probe = await fetchInTab(tabId, candidate.url);
	if (!probe.ok && probe.status === 0 && candidate.format !== "index") {
		const fromWorker = await fetchInWorker(candidate.url);
		if (fromWorker.ok) probe = fromWorker;
	}
	if (probe.ok && probe.kind === "binary") {
		await ingestDocument({
			meta: {
				source: ctx.source,
				kind: documentKind,
				externalOrderId: candidate.externalOrderId,
				originUrl: probe.finalUrl,
				fileName: fileNameFor(candidate, ctx.source, probe),
			},
			file: new Blob([base64ToBytes(probe.base64)], { type: probe.contentType }),
			label: candidate.label,
		});
		return "uploaded";
	}
	if (probe.ok && probe.kind === "html" && candidate.format === "index") {
		const store = storeForUrl(candidate.url);
		const nested = findInvoiceCandidates(
			store,
			probe.links,
			candidate.externalOrderId ? [candidate.externalOrderId] : [],
		)
			// Don't recurse into further indexes.
			.filter((c) => c.format !== "index" && c.url !== candidate.url)
			.map((c) => ({ ...c, externalOrderId: c.externalOrderId ?? candidate.externalOrderId }));
		if (nested.length === 0) throw new Error("invoice list contained no invoice links");
		expand(nested);
		return "uploaded";
	}
	if (candidate.format === "pdf") throw new Error(probe.ok ? "Expected a PDF, received HTML" : probe.error);
	// HTML page, or the in-tab fetch failed (cross-origin etc.): open it in a tab.
	return captureHtmlInvoice(candidate, ctx);
}

export async function runInvoiceJob(
	tabId: number,
	source: StoreId,
	pageUrl: string,
	candidates: InvoiceCandidate[],
): Promise<string> {
	const jobId = crypto.randomUUID();
	const queue = candidates.slice(0, MAX_INVOICES_PER_JOB);
	await setState("invoiceJob", {
		id: jobId,
		tabId,
		startedAt: Date.now(),
		items: queue.map((c) => ({ url: c.url, label: c.label, status: "pending" })),
	});
	const settings = await getSettings();
	const ctx: HandleContext = {
		source,
		pageUrl,
		canPrint: settings.printInvoicesToPdf && (await hasDebuggerPermission()),
	};
	const pageType = classifyUrl(pageUrl).pageType;
	const documentKind: DocumentKind =
		pageType === "invoice" || pageType === "order_detail" || pageType === "order_list" ? "invoice" : "receipt";

	void (async () => {
		for (let i = 0; i < queue.length; i++) {
			const candidate = queue[i];
			if (!candidate) continue;
			await setItem(jobId, i, { status: "working" });
			try {
				const status = await handleCandidate(tabId, candidate, ctx, documentKind, (found) => {
					const room = MAX_INVOICES_PER_JOB - queue.length;
					const known = new Set(queue.map((q) => q.url));
					const extra = found.filter((f) => !known.has(f.url)).slice(0, Math.max(0, room));
					queue.push(...extra);
					void updateJob(jobId, (job) => ({
						...job,
						items: [...job.items, ...extra.map((c) => ({ url: c.url, label: c.label, status: "pending" as const }))],
					}));
				});
				await setItem(jobId, i, {
					status,
					message: candidate.format === "index" ? "expanded" : undefined,
				});
			} catch (err) {
				await setItem(jobId, i, { status: "error", message: errorMessage(err).slice(0, 200) });
			}
		}
		await updateJob(jobId, (job) => ({ ...job, finishedAt: Date.now() }));
	})();
	return jobId;
}

/** PDF viewers may not run store content scripts; tab navigation wakes the worker. */
let visitedInvoiceChain: Promise<unknown> = Promise.resolve();

export function saveVisitedMouserInvoice(tabId: number, url: string): Promise<void> {
	const next = visitedInvoiceChain.then(() => saveVisitedInvoice(tabId, url));
	visitedInvoiceChain = next.catch(() => undefined);
	return next;
}

async function saveVisitedInvoice(tabId: number, url: string): Promise<void> {
	const number = mouserPdfInvoiceNumber(url);
	if (!number) return;
	const settings = await getSettings();
	if (!isConfigured(settings) || !settings.passiveCapture || !settings.stores.mouser) return;
	const externalOrderId = await orderForMouserInvoice(number);
	const candidate: InvoiceCandidate = { url, format: "pdf", label: "Mouser invoice", externalOrderId };
	let probe = await fetchInTab(tabId, url);
	if (!probe.ok && probe.status === 0) probe = await fetchInWorker(url);
	if (!probe.ok) throw new Error(probe.error);
	if (probe.kind !== "binary" || !probe.contentType.includes("application/pdf"))
		throw new Error("Expected a PDF invoice response");
	const bytes = base64ToBytes(probe.base64);
	if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Invalid PDF invoice response");
	const hash = await sha256Hex(`mouser-pdf:${url}:${probe.base64}`);
	const now = Date.now();
	const hashes = await getState("recentHashes");
	if (isRecentDuplicate(hashes, hash, now)) return;
	await ingestDocument({
		meta: {
			source: "mouser",
			kind: "invoice",
			externalOrderId,
			originUrl: url,
			fileName: fileNameFor(candidate, "mouser", probe),
		},
		file: new Blob([bytes], { type: "application/pdf" }),
		label: candidate.label,
	});
	await serialized(async () => {
		await setState("recentHashes", rememberHash(await getState("recentHashes"), hash, now));
	});
}
