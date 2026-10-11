/**
 * Functions injected into tabs with `scripting.executeScript`.
 *
 * Each function is serialized and run in the page's isolated world, so it
 * MUST be self-contained: no imports, no closures over module scope, only
 * its arguments. Return values must be JSON-serializable.
 */

export interface PageProbe {
	url: string;
	title: string;
	text: string;
	/** Text of elements matching the store's order-id selectors. */
	domText: string;
	links: Array<{ href: string; text: string; id?: string }>;
}

/** Visible text, title, order-id widget text and anchors of the current page. */
export function probePage(maxTextChars: number, maxLinks: number, idSelectors: string[]): PageProbe {
	const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
	const anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, maxLinks);
	let domText = "";
	if (idSelectors.length > 0) {
		try {
			domText = Array.from(document.querySelectorAll(idSelectors.join(",")))
				.slice(0, 500)
				.map((el) => el.textContent ?? "")
				.join("\n");
		} catch {
			domText = "";
		}
	}
	return {
		url: location.href,
		title: document.title,
		text: text.slice(0, maxTextChars),
		domText,
		links: anchors.map((a) => ({
			href: (a as HTMLAnchorElement).href,
			text: ((a as HTMLElement).innerText || a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().slice(0, 200),
			id: a.id || undefined,
		})),
	};
}

/** Full serialized DOM. */
export function grabHtml(): { url: string; title: string; html: string } {
	const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : "";
	return { url: location.href, title: document.title, html: doctype + document.documentElement.outerHTML };
}

export type FetchProbeResult =
	| { ok: true; status: number; finalUrl: string; contentType: string; kind: "binary"; base64: string; size: number; fileName: string | null }
	| { ok: true; status: number; finalUrl: string; contentType: string; kind: "html"; links: Array<{ href: string; text: string; id?: string }> }
	| { ok: false; status: number; error: string };

/**
 * Fetch a URL with the page's cookies (same-origin to the page). PDFs and
 * other binaries come back as base64; HTML comes back as its anchors so the
 * caller can decide whether it is an invoice index or a printable page.
 */
export async function fetchFromPage(url: string, maxBytes: number): Promise<FetchProbeResult> {
	try {
		const res = await fetch(url, { credentials: "include", redirect: "follow" });
		if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		const disposition = res.headers.get("content-disposition") ?? "";
		const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
		const fileName = nameMatch?.[1] ? decodeURIComponent(nameMatch[1]) : null;
		if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
			const html = await res.text();
			const doc = new DOMParser().parseFromString(html, "text/html");
			const base = doc.createElement("base");
			base.href = res.url || url;
			doc.head.prepend(base);
			const links = Array.from(doc.querySelectorAll("a[href]"))
				.slice(0, 2000)
				.map((a) => ({
					href: (a as HTMLAnchorElement).href,
					text: (a.textContent || a.getAttribute("aria-label") || "").trim().slice(0, 200),
					id: a.id || undefined,
				}));
			return { ok: true, status: res.status, finalUrl: res.url || url, contentType, kind: "html", links };
		}
		const buf = await res.arrayBuffer();
		if (buf.byteLength > maxBytes) return { ok: false, status: res.status, error: `file too large (${buf.byteLength} bytes)` };
		const bytes = new Uint8Array(buf);
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}
		return {
			ok: true,
			status: res.status,
			finalUrl: res.url || url,
			contentType: contentType || "application/octet-stream",
			kind: "binary",
			base64: btoa(binary),
			size: buf.byteLength,
			fileName,
		};
	} catch (err) {
		return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
	}
}
