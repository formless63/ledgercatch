/**
 * Per-store knowledge: which hosts belong to a store, how to classify a URL
 * into a page type, which in-page API responses are worth intercepting, how to
 * spot order-number hints, and where invoices live.
 *
 * Everything here is pure data + pure functions (regexes only) so it can be
 * bundled into the MAIN-world interceptor, the isolated content script, the
 * service worker and the popup, and unit-tested in Node.
 *
 * Only `import type` from the contract: the MAIN-world bundle must stay tiny
 * and must not pull in zod.
 */
import type { PageType, StoreId } from "@app/shared/capture";

export type SupportedStoreId = Exclude<StoreId, "generic">;

export type InvoiceLinkFormat =
	/** Server returns a PDF (or other binary); fetch bytes and upload. */
	| "pdf"
	/** An HTML page meant for printing; print to PDF (or snapshot as fallback). */
	| "html"
	/** An HTML fragment/popover listing the real invoice links; expand it. */
	| "index"
	/** Not sure: fetch and sniff the content type. */
	| "unknown";

export interface InvoiceLinkRule {
	/** Tested against the absolute href. */
	href: RegExp;
	format: InvoiceLinkFormat;
}

export interface PageTypeRule {
	type: Exclude<PageType, "unknown">;
	/** Tested against `host + pathname + search` (see `urlKey`). */
	test: RegExp;
}

export interface OrderIdPatterns {
	/** Applied to page URLs and link hrefs. Group 1 (if present) is the ID. */
	url: RegExp[];
	/**
	 * Applied to the whole visible page text. Must be global. Group 1 (if
	 * present) is the ID. Leave empty when the ID shape collides with other
	 * page noise (Amazon: the session-id cookie has the order-id shape).
	 */
	text: RegExp[];
	/**
	 * Applied only to the text of elements matching `selectors` (order-id
	 * widgets). `pattern` must be global.
	 */
	dom?: { selectors: string[]; pattern: RegExp };
	/** Applied to serialized JSON bodies. Must be global. Group 1 (if present) is the ID. */
	json: RegExp[];
}

export interface StoreDefinition {
	id: SupportedStoreId;
	label: string;
	/** Registrable domains; subdomains match too. */
	domains: string[];
	pageTypes: PageTypeRule[];
	/** In-page fetch/XHR URLs whose JSON responses carry order data. */
	apiPatterns: RegExp[];
	/**
	 * Store API calls that match `apiPatterns`/`jsonSniff` but never carry
	 * orders (translations, recommendations, watch lists). Not captured,
	 * except in recorder mode.
	 */
	apiIgnore?: RegExp[];
	/**
	 * For stores whose order-API paths are not known: a JSON response (any
	 * URL on the store) whose raw text matches this is treated as an order API
	 * response.
	 */
	jsonSniff?: RegExp;
	orderIds: OrderIdPatterns;
	invoiceLinks: InvoiceLinkRule[];
	/** Anchors whose element id matches are invoice links regardless of text (ASP.NET grids). */
	invoiceLinkIds?: RegExp;
	/** The order-detail page itself is the receipt (offer to save it as the invoice). */
	detailIsReceipt?: boolean;
	/** While any element matches, the page is still rendering order data (e.g. Amazon CSD decryption). */
	notReadySelector?: string;
}

/** Anchor text that suggests an invoice/receipt link on any store. */
export const INVOICE_TEXT_PATTERN =
	/\b(invoices?|receipts?|rechnung(en)?|facture|factura|fattura|print(able)?\s+(order|receipt|invoice)|order\s+summary|tax\s+invoice)\b/i;

const AMAZON_ORDER_ID = /\b(?:D\d{2}|\d{3})-\d{7}-\d{7}\b/g;

const AMAZON: StoreDefinition = {
	id: "amazon",
	label: "Amazon",
	domains: ["amazon.com", "amazon.ca", "amazon.co.uk", "amazon.de"],
	pageTypes: [
		{
			type: "invoice",
			test: /\/(gp\/css\/summary\/print\.html|gp\/digital\/your-account\/invoice|documents\/download\/|your-orders\/invoice)|\/gp\/digital\/your-account\/order-summary\.html\?(.*&)?print=1/i,
		},
		{
			type: "order_confirmation",
			test: /\/(gp\/buy\/thankyou|gp\/buy\/spc\/handlers\/static-submit|checkout\/.*thank-?you|gp\/checkoutportal\/thankyou)/i,
		},
		{
			type: "order_detail",
			test: /\/(gp\/your-account\/order-details|your-orders\/order-details|gp\/css\/order-details|gp\/your-account\/ship-track|progress-tracker\/package|gp\/digital\/your-account\/order-summary)/i,
		},
		{
			type: "order_list",
			test: /\/(gp\/css\/order-history|gp\/your-account\/order-history|your-orders\/orders|gp\/legacy\/order-history|your-orders\/?(\?|$))/i,
		},
	],
	// Order pages are server-rendered HTML (no JSON order API); a few widgets load fragments.
	apiPatterns: [/\/your-orders\/(api|ajax)\//i],
	orderIds: {
		// Only order-ish URLs: the session-id cookie has the same shape and shows up in telemetry URLs.
		url: [/[?&](?:orderID|orderId|order_id)=((?:\d{3}|D\d{2})-\d{7}-\d{7})\b/i],
		text: [],
		dom: {
			selectors: [
				".yohtmlc-order-id",
				'[data-component="orderId"]',
				'[data-component="briefOrderInfo"]',
				".order-date-invoice-item",
			],
			pattern: AMAZON_ORDER_ID,
		},
		json: [],
	},
	invoiceLinks: [
		{ href: /\/documents\/download\/[^?#]*\.pdf/i, format: "pdf" },
		{ href: /\/documents\/download\//i, format: "unknown" },
		{ href: /\/gp\/css\/summary\/print\.html/i, format: "html" },
		{ href: /\/gp\/digital\/your-account\/(invoice|order-summary)/i, format: "html" },
		{
			href: /\/(your-orders\/invoice\/popover|gp\/shared-cs\/ajax\/invoice\/invoice\.html)/i,
			format: "index",
		},
	],
	notReadySelector: ".csd-encrypted-sensitive script",
};

const ALIEXPRESS: StoreDefinition = {
	id: "aliexpress",
	label: "AliExpress",
	domains: ["aliexpress.com", "aliexpress.us"],
	pageTypes: [
		{ type: "invoice", test: /\/(p\/invoice|invoice)[\w\-/]*(\.html)?/i },
		// Exact post-payment path unverified; /p/trade/confirm.html is pre-payment checkout, not a confirmation.
		{ type: "order_confirmation", test: /\/p\/trade\/(payresult|pay-result|paysuccess|pay_success)/i },
		{ type: "order_detail", test: /\/p\/order\/detail\.html|\/order_detail\.htm|\/p\/tracking\//i },
		{ type: "order_list", test: /\/p\/order\/index\.html|\/order_list\.htm|\/p\/order\/?(\?|$)/i },
	],
	apiPatterns: [
		/mtop\.aliexpress\.trade\.buyer\.order\.(list|detail)/i,
		/mtop\.ae\.ld\.querydetail/i,
		/mtop\.aliexpress\.buyer\.reverse\.queryreverseorder/i,
	],
	orderIds: {
		url: [/[?&](?:orderId|orderIds|order_id|tradeOrderId)=(\d{15,19})\b/i],
		text: [/order\s*(?:id|no\.?|number|#)\s*[:：#.]?\s*(\d{15,19})\b/gi],
		json: [/"(?:orderId|orderIdStr|tradeOrderId|orderNo)"\s*:\s*"?(\d{15,19})\b/g],
	},
	invoiceLinks: [
		{ href: /\.pdf(\?|#|$)/i, format: "pdf" },
		{ href: /invoice/i, format: "unknown" },
	],
};

const ALIBABA: StoreDefinition = {
	id: "alibaba",
	label: "Alibaba.com",
	domains: ["alibaba.com"],
	pageTypes: [
		{ type: "invoice", test: /^biz\.alibaba\.com\/.*invoice/i },
		{
			type: "order_confirmation",
			test: /^biz\.alibaba\.com\/(order|trade|payment)\/[\w\-/]*(success|result|confirm(ation)?)\b/i,
		},
		{
			type: "order_detail",
			test: /^biz\.alibaba\.com(?:\/ta\/detail\.htm|\/(order|ta\/buyer)\/(order)?detail|orderdetail)/i,
		},
		{
			type: "order_list",
			test: /^biz\.alibaba\.com(?:\/order\/list\.htm|\/generalorders\/list_orders|order_list\.htm|\/ta\/buyer\/list|orderlist)/i,
		},
	],
	apiPatterns: [/mtop\.alibaba\.intl\.[\w.]*(order|trade)/i, /\/order\/ajax\//i],
	apiIgnore: [
		/cashier\.alibaba\.com\/payment\//i,
		/\/list\/ajax\/ta\/order\/trace\.json/i,
		/mtop\.alibaba\.intl\.camel\.ai\.tradeagent\./i,
	],
	// Endpoints unknown: keep any JSON response that talks about orders.
	jsonSniff: /"(?:orderId|tradeOrderId|orderIdStr)"\s*:/,
	orderIds: {
		url: [/[?&](?:orderId|order_id|tradeId|tradeOrderId)=(\d{12,20})\b/i],
		text: [/order\s*(?:id|no\.?|number|#)\s*[:：#.]?\s*(\d{12,20})\b/gi],
		json: [/"(?:orderId|tradeOrderId|orderIdStr|tradeId)"\s*:\s*"?(\d{12,20})\b/g],
	},
	invoiceLinks: [
		{ href: /\.pdf(\?|#|$)/i, format: "pdf" },
		{ href: /invoice/i, format: "unknown" },
	],
};

const EBAY: StoreDefinition = {
	id: "ebay",
	label: "eBay",
	domains: ["ebay.com", "ebay.ca", "ebay.co.uk", "ebay.de", "ebay.com.au"],
	pageTypes: [
		{ type: "invoice", test: /\/(ord\/print|vod\/[\w/]*print|printable)/i },
		{
			type: "order_confirmation",
			test: /^pay\.ebay\.[\w.]+\/[\w\-/]*(success|confirm|thank)|^pay\.ebay\.[\w.]+\/rx?g?xo\b.*(success|confirm|thank)|\/ct\/purchase-confirmation/i,
		},
		{ type: "order_detail", test: /^order\.ebay\.[\w.]+\/ord\/show|\/vod\/fetchorderdetails|\/ord\/show/i },
		{ type: "order_list", test: /\/mye\/myebay\/(v2\/)?purchase|\/myb\/purchasehistory/i },
	],
	apiPatterns: [
		/\/mye\/myebay\/ajax\/v2\/purchase\//i,
		/\/mye\/myebay\/(ajax|rest|api)\//i,
		/order\.ebay\.[\w.]+\/ord\/(api|ajax)/i,
	],
	// Placement ads ("nuts") and watch-list widgets on the purchase pages.
	apiIgnore: [/\/mye\/myebay\/ajax\/[\w/]*\/nuts\//i, /\/mye\/myebay\/ajax\/watch\//i],
	orderIds: {
		url: [/[?&]orderId=(\d{2}-\d{5}-\d{5}|\d{5,}-\d{5,})\b/i],
		text: [/\b\d{2}-\d{5}-\d{5}\b/g],
		json: [/\b\d{2}-\d{5}-\d{5}\b/g],
	},
	invoiceLinks: [
		{ href: /\.pdf(\?|#|$)/i, format: "pdf" },
		{ href: /invoice/i, format: "unknown" },
	],
	// The order-details page is the receipt.
	detailIsReceipt: true,
};

const DIGIKEY: StoreDefinition = {
	id: "digikey",
	label: "DigiKey",
	domains: ["digikey.com", "digikey.ca", "digikey.co.uk", "digikey.de"],
	pageTypes: [
		{ type: "invoice", test: /invoice|\/viewpdf/i },
		{
			type: "order_confirmation",
			test: /\/(ordering\/)?[\w\-/]*(order-?confirmation|ordercomplete|order-complete|checkout\/(confirmation|complete|success))/i,
		},
		{ type: "order_detail", test: /\/orderhistory\/(revieworder|guest\/orderstatus)|\/mydigikey\/revieworder/i },
		{ type: "order_list", test: /\/orderhistory(\/list)?\/?(\?|$)|\/orderhistory\/list/i },
	],
	// Exact XHR paths are unconfirmed: anything JSON under /OrderHistory/ plus a field sniff.
	apiPatterns: [/\/orderhistory\//i, /digikey\.[\w.]+\/[\w\-/]*api[\w\-/]*\/[\w\-/]*(order|invoice)/i],
	jsonSniff: /"(?:orderNumber|invoiceDetails|salesOrderNumber|invoiceTotalPrice)"\s*:/,
	// Seen on the order pages; translations, lookups and product search only.
	apiIgnore: [/\/orderhistory\/api\/(phrases|seourl|returns|productsearch)\b/i],
	orderIds: {
		url: [/[?&](?:salesOrder(?:Id|Number)?|orderId|orderNumber|webId)=(\d{8,16})\b/i, /\/revieworder\/(\d{8,16})\b/i],
		text: [/(?:sales\s*order|order)\s*(?:#|no\.?|number)\s*[:#]?\s*(\d{8,16})\b/gi],
		json: [/"(?:salesOrderNumber|orderNumber|salesOrderId)"\s*:\s*"?(\d{8,16})\b/gi],
	},
	invoiceLinks: [
		{ href: /\.pdf(\?|#|$)/i, format: "pdf" },
		{ href: /invoice|viewpdf/i, format: "unknown" },
	],
};

const MOUSER: StoreDefinition = {
	id: "mouser",
	label: "Mouser",
	domains: ["mouser.com", "mouser.ca", "mouser.co.uk", "mouser.de"],
	pageTypes: [
		{ type: "invoice", test: /invoice/i },
		{ type: "order_confirmation", test: /\/(cart|checkout|order)[\w\-/]*(confirmation|complete|thank-?you)/i },
		{ type: "order_detail", test: /\/orderhistory\/orderdetail|\/order-?detail/i },
		{ type: "order_list", test: /\/orderhistory\/ordersview|\/orderhistory\/?(\?|$)/i },
	],
	apiPatterns: [
		/\/orderhistory\/[\w\-/]*(\.ashx|\/api\/|data|grid|filter)/i,
		/mouser\.[\w.]+\/[\w\-/]*api[\w\-/]*\/[\w\-/]*order/i,
	],
	jsonSniff: /"(?:SalesOrderNumber|WebOrderNumber|salesOrderNumber|webOrderNumber)"\s*:/,
	apiIgnore: [/\/api\/orderhistory\/anyorderswithorganization\b/i],
	orderIds: {
		url: [/[?&](?:orderNumber|webOrderNumber|salesOrderNumber|orderId)=(\d{6,10})\b/i],
		text: [/(?:sales\s*order|web\s*order)\s*(?:#|no\.?|number)?\s*[:#]?\s*(\d{6,10})\b/gi],
		dom: {
			selectors: ['[id$="lblSalesOrderNumber"]', '[id$="lblWebOrderNumber"]', '[id$="lnkSalesOrderNumber"]'],
			pattern: /\b\d{6,10}\b/g,
		},
		json: [/"(?:salesOrderNumber|webOrderNumber)"\s*:\s*"?(\d{6,10})\b/gi],
	},
	invoiceLinks: [
		{ href: /\/account\/invoices\/detail\/\d+\/pdf(?:[?#]|$)/i, format: "pdf" },
		{ href: /\.pdf(\?|#|$)/i, format: "pdf" },
		{ href: /invoice/i, format: "unknown" },
	],
	invoiceLinkIds: /lnkInvoice$/i,
};

export const STORES: readonly StoreDefinition[] = [AMAZON, ALIEXPRESS, ALIBABA, EBAY, DIGIKEY, MOUSER];

export const SUPPORTED_STORE_IDS: readonly SupportedStoreId[] = STORES.map((s) => s.id);

export const STORE_LABELS: Record<StoreId, string> = {
	amazon: AMAZON.label,
	aliexpress: ALIEXPRESS.label,
	alibaba: ALIBABA.label,
	ebay: EBAY.label,
	digikey: DIGIKEY.label,
	mouser: MOUSER.label,
	generic: "Other site",
};

/** Manifest match patterns for every supported store (apex + subdomains). */
export const STORE_MATCHES: string[] = STORES.flatMap((s) => s.domains.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]));

/** host_permissions entries (same as matches, kept separate for clarity). */
export const STORE_HOST_PERMISSIONS: string[] = [...STORE_MATCHES];

export function getStore(id: SupportedStoreId): StoreDefinition {
	const store = STORES.find((s) => s.id === id);
	if (!store) throw new Error(`Unknown store ${id}`);
	return store;
}

function hostMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function safeUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		return null;
	}
}

/** `host + pathname + search`, lowercased host, used for page-type rules. */
export function urlKey(url: URL): string {
	return `${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
}

export function storeForUrl(url: string): StoreDefinition | null {
	const parsed = safeUrl(url);
	if (!parsed || !/^https?:$/.test(parsed.protocol)) return null;
	const host = parsed.hostname.toLowerCase();
	return STORES.find((s) => s.domains.some((d) => hostMatches(host, d))) ?? null;
}

export interface PageClassification {
	source: StoreId;
	store: StoreDefinition | null;
	pageType: PageType;
}

export function classifyUrl(url: string): PageClassification {
	const store = storeForUrl(url);
	if (!store) return { source: "generic", store: null, pageType: "unknown" };
	const parsed = new URL(url);
	const key = urlKey(parsed);
	const rule = store.pageTypes.find((r) => r.test.test(key));
	return { source: store.id, store, pageType: rule?.type ?? "unknown" };
}

/** Text of the elements a store marks as order-id widgets (DOM contexts only). */
export function collectOrderIdDomText(store: StoreDefinition | null, root: ParentNode): string {
	const selectors = store?.orderIds.dom?.selectors;
	if (!selectors?.length) return "";
	const parts: string[] = [];
	for (const el of root.querySelectorAll(selectors.join(","))) {
		parts.push(el.textContent ?? "");
		if (parts.length >= 500) break;
	}
	return parts.join("\n");
}

/** True for store API calls known never to carry order data. */
export function isIgnoredApiUrl(store: StoreDefinition, requestUrl: string): boolean {
	return store.apiIgnore?.some((p) => p.test(requestUrl)) ?? false;
}

/** True when a fetch/XHR URL is one of the store's known order APIs. */
export function isOrderApiUrl(store: StoreDefinition, requestUrl: string): boolean {
	return !isIgnoredApiUrl(store, requestUrl) && store.apiPatterns.some((p) => p.test(requestUrl));
}

export const MAX_ORDER_ID_HINTS = 200;
const MAX_HINT_LENGTH = 120;

function collect(pattern: RegExp, input: string, out: Set<string>): void {
	if (out.size >= MAX_ORDER_ID_HINTS) return;
	if (pattern.global) {
		pattern.lastIndex = 0;
		for (const m of input.matchAll(pattern)) {
			const id = (m[1] ?? m[0]).trim();
			if (id && id.length <= MAX_HINT_LENGTH) out.add(id);
			if (out.size >= MAX_ORDER_ID_HINTS) return;
		}
	} else {
		const m = pattern.exec(input);
		const id = m ? (m[1] ?? m[0]).trim() : "";
		if (id && id.length <= MAX_HINT_LENGTH) out.add(id);
	}
}

export interface OrderIdSources {
	urls?: string[];
	/** Whole visible page text. */
	text?: string;
	/** Text of the store's `orderIds.dom.selectors` elements. */
	domText?: string;
	json?: string;
}

/** Cheap, best-effort order-number hints. The server does the real parsing. */
export function extractOrderIdHints(store: StoreDefinition | null, sources: OrderIdSources): string[] {
	if (!store) return [];
	const out = new Set<string>();
	for (const url of sources.urls ?? []) {
		for (const p of store.orderIds.url) collect(p, url, out);
	}
	if (sources.text) {
		for (const p of store.orderIds.text) collect(p, sources.text, out);
	}
	if (sources.domText && store.orderIds.dom) collect(store.orderIds.dom.pattern, sources.domText, out);
	if (sources.json) {
		for (const p of store.orderIds.json) collect(p, sources.json, out);
	}
	return [...out].slice(0, MAX_ORDER_ID_HINTS);
}

export interface PageLink {
	href: string;
	text: string;
	/** Element id, when present (used for ASP.NET-style invoice links). */
	id?: string;
}

export interface InvoiceCandidate {
	url: string;
	label: string;
	format: InvoiceLinkFormat;
	externalOrderId?: string;
}

/**
 * Pick invoice links out of a page's anchors. Store rules win; otherwise an
 * anchor whose text looks like "Invoice"/"Receipt" is accepted as `unknown`.
 */
export function findInvoiceCandidates(
	store: StoreDefinition | null,
	links: PageLink[],
	pageOrderIds: string[] = [],
): InvoiceCandidate[] {
	const seen = new Map<string, InvoiceCandidate>();
	for (const link of links) {
		const parsed = safeUrl(link.href);
		if (!parsed || !/^https?:$/.test(parsed.protocol)) continue;
		parsed.hash = "";
		const href = parsed.toString();
		if (seen.has(href)) continue;
		const rule = store?.invoiceLinks.find((r) => r.href.test(href));
		const textHit = INVOICE_TEXT_PATTERN.test(link.text) || Boolean(link.id && store?.invoiceLinkIds?.test(link.id));
		if (!rule && !textHit) continue;
		const ids = extractOrderIdHints(store, { urls: [href] });
		const externalOrderId = ids[0] ?? (pageOrderIds.length === 1 ? pageOrderIds[0] : undefined);
		seen.set(href, {
			url: href,
			label: link.text.replace(/\s+/g, " ").trim().slice(0, 80) || parsed.pathname.split("/").pop() || "invoice",
			format: rule?.format ?? "unknown",
			externalOrderId,
		});
	}
	return [...seen.values()];
}
