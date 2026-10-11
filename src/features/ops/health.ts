/** Pure pipeline-health helpers shared by the owner panel and Ops/Admin. */

export const FAILURE_MIN_SAMPLES = 5;
export const FAILURE_RATE_THRESHOLD = 0.2;
export const STUCK_SENDING_MINUTES = 10;
export const STALE_CLAIM_MINUTES = 30;

export type ParserVersionStats = {
	parserId: string;
	parserVersion: number | null;
	total: number;
	failed: number;
	noOrders: number;
	needsReview: number;
};

/** Failure share (failed + needs_review) as a 0..1 fraction. */
export function failureRate(row: ParserVersionStats) {
	return row.total > 0 ? (row.failed + row.needsReview) / row.total : 0;
}

/** A parser+version is "failing" once it has enough samples and a high failure share. */
export function isFailing(row: ParserVersionStats) {
	return (
		row.total >= FAILURE_MIN_SAMPLES &&
		failureRate(row) >= FAILURE_RATE_THRESHOLD
	);
}

/** Registry versions as a lookup; used to flag captures parsed by older versions. */
export function versionMap(parsers: { source: string; version: number }[]) {
	return new Map(parsers.map((p) => [p.source as string, p.version]));
}

/** Count names for Ops adapters must match the capability's machine-id rule. */
export function machineName(value: string) {
	const name = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) ? name : null;
}

/** Ops responses carry identifiers only; clip anything user-influenced. */
export function clip(value: string | null | undefined, max = 64) {
	const v = (value ?? "").replace(/[\p{Cc}<>]/gu, "");
	return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
