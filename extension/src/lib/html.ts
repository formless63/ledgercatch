import { byteLength, truncateToBytes } from "./util";

/**
 * Fit a serialized document under `maxBytes`, dropping the least useful
 * parts first: stylesheets and inline SVG, then executable scripts (JSON
 * data scripts are kept — they often hold the order data), then truncate.
 */
export function shrinkHtml(html: string, maxBytes: number): string {
	if (byteLength(html) <= maxBytes) return html;
	let s = html
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style></style>")
		.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "<svg></svg>")
		.replace(/\sstyle="[^"]{200,}"/gi, "");
	if (byteLength(s) <= maxBytes) return s;
	s = s.replace(
		/<script\b(?![^>]*\btype=["']?application\/(?:ld\+)?json)[^>]*>[\s\S]*?<\/script>/gi,
		"<script></script>",
	);
	if (byteLength(s) <= maxBytes) return s;
	return truncateToBytes(s, maxBytes);
}

export function serializeDocument(doc: Document): string {
	const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "";
	return `${doctype}${doc.documentElement.outerHTML}`;
}

/** Inline scripts worth keeping: order data the server parsers read. */
const ORDER_DATA_SCRIPT_RE =
	/Shopify\.(?:checkout|currency|shop)\s*=|["']?transaction_?id["']?\s*:|actionField|["']?event["']?\s*:\s*["']purchase["']/;

/**
 * Drop page code before sending a DOM to the server: every `<script>` body is
 * emptied (tag and attributes such as `src` stay, they identify the
 * platform) except JSON-LD and scripts holding order data (Shopify.checkout,
 * GA4 / UA purchase events). Stylesheets and inline SVG are emptied too.
 */
export function stripForCapture(html: string): string {
	return html
		.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (whole, attrs: string, body: string) => {
			if (/\btype\s*=\s*["']?application\/ld\+json/i.test(attrs)) return whole;
			if (body && ORDER_DATA_SCRIPT_RE.test(body)) return whole;
			return `<script${attrs}></script>`;
		})
		.replace(/<style\b([^>]*)>[\s\S]*?<\/style>/gi, "<style$1></style>")
		.replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, "<svg$1></svg>");
}

/** Serialized, stripped and size-bounded DOM for "Track this page" / auto-detect. */
export function captureHtml(html: string, maxBytes: number): string {
	return shrinkHtml(stripForCapture(html), maxBytes);
}

/**
 * HTML invoice saved as a document (text/html) when PDF printing is not
 * available: every script removed (the server serves it as text anyway),
 * styles kept so the markup stays readable, size-bounded.
 */
export function invoiceDocumentHtml(html: string, maxBytes: number): string {
	const noScripts = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<script\b[^>]*\/?>/gi, "")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
	return shrinkHtml(noScripts, maxBytes);
}
