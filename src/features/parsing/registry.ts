import type { StoreId } from "#/shared/capture";
import { alibabaParser } from "./alibaba";
import { aliexpressParser } from "./aliexpress";
import { amazonParser } from "./amazon";
import { digikeyParser } from "./digikey";
import { ebayParser } from "./ebay";
import { genericParser } from "./generic";
import { mouserParser } from "./mouser";
import type { StoreParser } from "./types";

const PARSERS: StoreParser[] = [
	amazonParser,
	aliexpressParser,
	alibabaParser,
	ebayParser,
	digikeyParser,
	mouserParser,
	genericParser,
];

const BY_SOURCE = new Map<StoreId, StoreParser>(
	PARSERS.map((p) => [p.source, p]),
);

/** Feature-flag key gating one parser version, e.g. `parser.amazon.v2`. */
export function parserFlagKey(source: string, version: number) {
	return `parser.${source}.v${version}`;
}

/**
 * Synchronous gate consulted on every lookup. Returns false to switch a parser
 * version off; `undefined` means "no opinion" (parser stays enabled). The
 * default allows everything; the worker installs a Feature Flags-backed gate
 * (src/features/automation/parser-flags.server.ts).
 */
export type ParserGate = (flagKey: string) => boolean | undefined;
let gate: ParserGate = () => undefined;
export function setParserGate(next: ParserGate) {
	gate = next;
}

export function getParser(source: StoreId): StoreParser | undefined {
	const parser = BY_SOURCE.get(source);
	if (!parser) return undefined;
	return gate(parserFlagKey(parser.source, parser.version)) === false
		? undefined
		: parser;
}

export function listParsers(): StoreParser[] {
	return [...PARSERS];
}
