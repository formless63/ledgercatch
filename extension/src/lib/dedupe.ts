/** Pure helpers for the 24h "already sent this exact content" cache. */

export const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEDUPE_MAX_ENTRIES = 2000;

export type HashMap = Record<string, number>;

export function pruneHashes(map: HashMap, now: number, ttl = DEDUPE_TTL_MS, cap = DEDUPE_MAX_ENTRIES): HashMap {
	const live = Object.entries(map)
		.filter(([, ts]) => now - ts < ttl)
		.sort((a, b) => b[1] - a[1])
		.slice(0, cap);
	return Object.fromEntries(live);
}

export function isRecentDuplicate(map: HashMap, hash: string, now: number, ttl = DEDUPE_TTL_MS): boolean {
	const ts = map[hash];
	return ts !== undefined && now - ts < ttl;
}

export function rememberHash(map: HashMap, hash: string, now: number): HashMap {
	return pruneHashes({ ...map, [hash]: now }, now);
}
