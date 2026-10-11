import type { Doc } from "../html";
import type { ParsedOrder, ParserInput } from "../types";

/** Everything a platform parser may look at; built once per HTML capture. */
export type PlatformContext = {
	$: Doc;
	/** Raw HTML as captured (for cheap regex probes of inline scripts). */
	html: string;
	/** Page URL of the capture (base for relative links). */
	url: string;
	input: ParserInput;
	/** Caller-supplied currency for bare amounts / ambiguous "$". */
	currencyHint?: string;
};

/**
 * A self-hosted / SaaS storefront platform whose order pages have stable,
 * documented markup (theme templates shipped by the platform itself).
 *
 * Both functions are pure. `detect` is a cheap string/regex probe over the
 * raw HTML + URL and must only say yes for order pages (confirmation /
 * order detail), never for cart or product pages. `parse` returns the orders
 * it can see, or [] so the generic chain falls through to other extractors.
 */
export type Platform = {
	id: string;
	detect(html: string, url: string): boolean;
	parse(ctx: PlatformContext): ParsedOrder[];
};
