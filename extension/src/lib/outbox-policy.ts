/**
 * Pure retry/backoff policy for the upload outbox.
 *
 * - 2xx                → done
 * - 401/403            → auth: pause the whole queue until the user fixes the key
 * - 409/422 (+ other 4xx except 404/408/429) → permanent: drop item, record error
 * - 404/408/429/5xx/network → retry with exponential backoff + jitter
 */

export type Outcome = "ok" | "auth" | "permanent" | "retry";

export function classifyStatus(status: number): Outcome {
	if (status >= 200 && status < 300) return "ok";
	if (status === 401 || status === 403) return "auth";
	if (status === 404 || status === 408 || status === 425 || status === 429) return "retry";
	if (status >= 400 && status < 500) return "permanent";
	return "retry";
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const MAX_ATTEMPTS = 12;

/**
 * Delay before the next attempt after `attempts` failed attempts (1-based).
 * 30s, 60s, 2m, 4m, ... capped at 1h, with +/-20% jitter.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
	const n = Math.max(1, attempts);
	const raw = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
	const jitter = 1 + (random() * 0.4 - 0.2);
	return Math.round(Math.min(BACKOFF_MAX_MS, raw * jitter));
}

/** Parse a Retry-After header (seconds or HTTP date) into a delay in ms. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, date - now);
}

export interface RetryState {
	attempts: number;
	nextAttemptAt: number;
	status: "pending" | "failed";
	lastError?: string;
}

/** State after a retryable failure. Gives up (status "failed") after MAX_ATTEMPTS. */
export function afterRetryableFailure(
	prev: RetryState,
	error: string,
	now: number,
	retryAfterMs: number | null = null,
	random: () => number = Math.random,
): RetryState {
	const attempts = prev.attempts + 1;
	if (attempts >= MAX_ATTEMPTS) {
		return { attempts, nextAttemptAt: Number.POSITIVE_INFINITY, status: "failed", lastError: error };
	}
	const backoff = backoffDelayMs(attempts, random);
	const wait = retryAfterMs !== null ? Math.min(BACKOFF_MAX_MS, Math.max(backoff, retryAfterMs)) : backoff;
	return { attempts, nextAttemptAt: now + wait, status: "pending", lastError: error };
}

export function isDue(item: Pick<RetryState, "status" | "nextAttemptAt">, now: number): boolean {
	return item.status === "pending" && item.nextAttemptAt <= now;
}

/** Items to try now, oldest first. */
export function selectDue<T extends RetryState & { createdAt: number }>(items: T[], now: number): T[] {
	return items.filter((i) => isDue(i, now)).sort((a, b) => a.createdAt - b.createdAt);
}

/** "Retry now": everything pending or failed becomes due immediately (failed get a fresh budget). */
export function resetForManualRetry<T extends RetryState>(item: T, now: number): T {
	return {
		...item,
		status: "pending",
		nextAttemptAt: now,
		attempts: item.status === "failed" ? 0 : item.attempts,
	};
}
