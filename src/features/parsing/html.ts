// "cheerio/slim" avoids the undici-based fromURL loader, which the server bundle
// does not ship.
import { type CheerioAPI, load } from "cheerio/slim";
import type { AnyNode } from "domhandler";
import { cleanText } from "./text";
import type { ParsedDocumentLink } from "./types";

export type Doc = CheerioAPI;
export type Sel = ReturnType<CheerioAPI>;

export function loadHtml(html: string): Doc {
	return load(html);
}

const SKIP_TAGS = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"head",
]);
const BLOCK_TAGS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"dd",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
]);

type DomNode = AnyNode & {
	type: string;
	data?: string;
	name?: string;
	children?: AnyNode[];
};

function collect(node: AnyNode, out: string[], lines: boolean) {
	const n = node as DomNode;
	if (n.type === "text") {
		out.push(n.data ?? "");
		return;
	}
	if (n.type === "comment" || n.type === "directive" || n.type === "cdata")
		return;
	const name = n.name?.toLowerCase();
	if (name && SKIP_TAGS.has(name)) return;
	const block = lines && name !== undefined && BLOCK_TAGS.has(name);
	if (block) out.push("\n");
	else out.push(" ");
	for (const child of n.children ?? []) collect(child, out, lines);
	if (block) out.push("\n");
	else out.push(" ");
}

/** Text of a selection with spaces between elements (no "Order placedOctober"). */
export function textOf(sel: Sel | undefined): string {
	if (!sel || sel.length === 0) return "";
	const out: string[] = [];
	sel.each((_, el) => {
		collect(el, out, false);
	});
	return cleanText(out.join(""));
}

/** Visible text with block elements on their own lines (scripts removed). */
export function linesOf(sel: Sel): string[] {
	const out: string[] = [];
	sel.each((_, el) => {
		collect(el, out, true);
	});
	return out
		.join("")
		.split(/\n+/)
		.map((line) => cleanText(line))
		.filter(Boolean);
}

/** First selector (in priority order) that matches something non-empty. */
export function pick(
	$: Doc,
	scope: Sel | undefined,
	selectors: string[],
): Sel | undefined {
	for (const selector of selectors) {
		try {
			const found = scope ? scope.find(selector) : $(selector);
			if (
				found.length > 0 &&
				(textOf(found.first()) || found.first().is("img,a,input"))
			)
				return found;
		} catch {
			// invalid selector for this engine; try the next
		}
	}
	return undefined;
}

export function pickText(
	$: Doc,
	scope: Sel | undefined,
	selectors: string[],
): string | undefined {
	const found = pick($, scope, selectors);
	return found ? textOf(found.first()) || undefined : undefined;
}

/** Safe `find` that never throws on unsupported selectors. */
export function findAll($: Doc, scope: Sel | undefined, selector: string): Sel {
	try {
		return scope ? scope.find(selector) : $(selector);
	} catch {
		return $([]);
	}
}

export function absUrl(
	href: string | undefined,
	base: string,
): string | undefined {
	if (!href) return undefined;
	const value = href.trim();
	if (!value || /^(javascript|mailto|tel|data):/i.test(value) || value === "#")
		return undefined;
	try {
		return new URL(
			value.startsWith("//") ? `https:${value}` : value,
			base,
		).toString();
	} catch {
		return undefined;
	}
}

export function imageUrl(
	img: Sel | undefined,
	base: string,
): string | undefined {
	if (!img || img.length === 0) return undefined;
	const first = img.first();
	const src =
		first.attr("data-a-hires") ??
		first.attr("data-src") ??
		first.attr("src") ??
		first.attr("data-original");
	if (!src || src.startsWith("data:")) return undefined;
	return absUrl(src, base);
}

const DOC_KIND_RES: Array<[RegExp, ParsedDocumentLink["kind"]]> = [
	[/packing[\s_-]*(slip|list)|lieferschein/i, "packing_slip"],
	[
		/invoice|rechnung|facture|factura|fattura|faktura|print\.html|proforma/i,
		"invoice",
	],
	[/receipt|beleg|quittung|recibo/i, "receipt"],
];

/**
 * Invoice / receipt / packing-slip links visible on the page. Uses link
 * text and href; skips javascript: links and help pages.
 */
export function documentLinks(
	$: Doc,
	base: string,
	scope?: Sel,
	extraHref?: RegExp,
): ParsedDocumentLink[] {
	const out: ParsedDocumentLink[] = [];
	findAll($, scope, "a[href]").each((_, el) => {
		const a = $(el);
		const href = a.attr("href") ?? "";
		const text = textOf(a);
		if (
			/help|customer-?service|policy|policies|faq|\/hz\/contact|gift[-_ ]?receipt|\/gcx\//i.test(
				`${href} ${text}`,
			)
		)
			return;
		const haystack = `${text} ${extraHref?.test(href) ? "invoice" : ""} ${/\.pdf(\?|$)/i.test(href) ? href : ""} ${href.replace(/[?#].*$/, "")}`;
		for (const [re, kind] of DOC_KIND_RES) {
			if (!re.test(haystack)) continue;
			const url = absUrl(href, base);
			if (url) out.push({ kind, url });
			return;
		}
	});
	return out;
}
