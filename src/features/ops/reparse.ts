/**
 * #3 Auto-reparse on parser version bump: pure planning helpers.
 */

/** Only deterministic store/generic parser kinds; page_text may fall back to AI and is left to manual re-parse. */
export const AUTO_REPARSE_KINDS = ["api_json", "html_snapshot"] as const;
/** Store-parser outcomes worth a retry when that store's parser changes. */
export const RETRY_STATUSES = ["failed", "no_orders"] as const;
export const DEFAULT_REPARSE_BUDGET = 200;

export type ReparseProgress = {
	parserId: string;
	targetVersion: number;
	cursorReceivedAt: Date | null;
	cursorId: string | null;
	completedAt: Date | null;
};

export type ReparseStep =
	| { action: "skip" }
	| { action: "reset" }
	| {
			action: "continue";
			cursor: { receivedAt: Date; id: string } | null;
	  };

/** What to do for one registry parser given its stored progress. */
export function planReparse(
	parser: { source: string; version: number },
	progress: ReparseProgress | undefined,
): ReparseStep {
	if (!Number.isSafeInteger(parser.version) || parser.version < 1)
		return { action: "skip" };
	if (!progress || progress.targetVersion !== parser.version)
		return { action: "reset" };
	if (progress.completedAt) return { action: "skip" };
	return {
		action: "continue",
		cursor:
			progress.cursorReceivedAt && progress.cursorId
				? { receivedAt: progress.cursorReceivedAt, id: progress.cursorId }
				: null,
	};
}

/** Parser ids that are never auto-reparsed (AI output, structured agent/import/email/document kinds). */
export function isAutoReparseParser(parserId: string) {
	return parserId !== "ai" && parserId !== "none" && parserId !== "agent";
}

export function reparseBudget(env: NodeJS.ProcessEnv = process.env) {
	const raw = env.AUTO_REPARSE_BATCH?.trim();
	if (raw && /^\d+$/.test(raw)) return Math.min(1000, Number(raw));
	return DEFAULT_REPARSE_BUDGET;
}
