/**
 * Feature Flags gate for store parsers. Each registered parser version has a
 * flag key `parser.<source>.v<version>`; when that flag is defined, its
 * evaluated value enables or disables the parser (kill switch / staged
 * rollout of a rewritten parser). Undefined flags and evaluation errors leave
 * parsers enabled. Values are cached process-wide for 60s and evaluated with
 * no user context, so only `enabled`/`defaultValue` apply (not overrides).
 */
import { db } from "#/db";
import {
	listParsers,
	parserFlagKey,
	setParserGate,
} from "#/features/parsing/registry";
import { defineFeatureFlags } from "#/integrations/feature-flags/feature-flags.server";

const TTL_MS = 60_000;
const flags = defineFeatureFlags();
let cache = new Map<string, boolean>();
let loadedAt = 0;
let inflight: Promise<void> | null = null;

export function parserFlagKeys() {
	return listParsers().map((parser) =>
		parserFlagKey(parser.source, parser.version),
	);
}

export async function refreshParserFlags() {
	inflight ??= (async () => {
		try {
			const result = await flags.evaluateMany(db, parserFlagKeys(), {});
			const next = new Map<string, boolean>();
			for (const [key, details] of Object.entries(result))
				if (details.reason !== "not-found" && details.reason !== "error")
					next.set(key, details.value);
			cache = next;
			loadedAt = Date.now();
		} catch {
			/* Keep the previous snapshot; parsers stay enabled by default. */
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/** Synchronous accessor used by the registry gate. */
export function parserFlag(key: string): boolean | undefined {
	if (Date.now() - loadedAt > TTL_MS) void refreshParserFlags();
	return cache.get(key);
}

/** Install the gate (idempotent). Await once at process start for a warm cache. */
export async function installParserFlagGate() {
	setParserGate(parserFlag);
	await refreshParserFlags();
}
