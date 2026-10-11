/**
 * Daily digest composition (pure). Counts come from digest.server.ts; this
 * module decides what to say, honouring per-user alert toggles.
 */
import { formatMoney } from "#/components/app/format";
import { appName } from "#/lib/app-name";
import type { AlertKind, AlertToggles } from "./schema";

export type DigestCounts = {
	inbox: number;
	/** Assigned orders older than 3 days without an invoice or receipt. */
	missingInvoices: number;
	pendingReimbursements: Array<{
		entityName: string;
		currency: string;
		totalMinor: number;
		count: number;
	}>;
	exports: { failed: number; stale: number };
	captures: { failed: number; needsReview: number };
	enrichment: number;
};

export type DigestLine = { kind: AlertKind; text: string; link: string };

export type Digest = {
	title: string;
	body: string;
	lines: DigestLine[];
	total: number;
};

/** Alerts default to on; only an explicit `false` turns one off. */
export function alertEnabled(
	alerts: AlertToggles | null | undefined,
	kind: AlertKind,
) {
	return alerts?.[kind] !== false;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

export function buildDigestLines(
	counts: DigestCounts,
	alerts: AlertToggles | null | undefined,
): DigestLine[] {
	const lines: DigestLine[] = [];
	const on = (kind: AlertKind) => alertEnabled(alerts, kind);
	if (on("inbox") && counts.inbox > 0)
		lines.push({
			kind: "inbox",
			text: `${plural(counts.inbox, "order")} waiting in the inbox`,
			link: "/app",
		});
	if (on("missingInvoices") && counts.missingInvoices > 0)
		lines.push({
			kind: "missingInvoices",
			text: `${plural(counts.missingInvoices, "assigned order")} older than 3 days without an invoice`,
			link: "/app/orders",
		});
	if (on("pendingReimbursements"))
		for (const row of counts.pendingReimbursements)
			if (row.count > 0)
				lines.push({
					kind: "pendingReimbursements",
					text: `${row.entityName}: ${formatMoney(row.totalMinor, row.currency)} pending reimbursement (${plural(row.count, "allocation")})`,
					link: "/app/reimbursements",
				});
	if (on("exports") && counts.exports.failed + counts.exports.stale > 0) {
		const parts = [
			counts.exports.failed ? `${counts.exports.failed} failed` : null,
			counts.exports.stale ? `${counts.exports.stale} out of date` : null,
		].filter(Boolean);
		lines.push({
			kind: "exports",
			text: `Exports need attention: ${parts.join(", ")}`,
			link: "/app/settings/connections",
		});
	}
	if (
		on("captures") &&
		counts.captures.failed + counts.captures.needsReview > 0
	) {
		const parts = [
			counts.captures.failed ? `${counts.captures.failed} failed` : null,
			counts.captures.needsReview
				? `${counts.captures.needsReview} need review`
				: null,
		].filter(Boolean);
		lines.push({
			kind: "captures",
			text: `Captures: ${parts.join(", ")}`,
			link: "/app/captures",
		});
	}
	if (on("enrichment") && counts.enrichment > 0)
		lines.push({
			kind: "enrichment",
			text: `${plural(counts.enrichment, "order")} waiting for details from the store`,
			link: "/app/orders",
		});
	return lines;
}

/** Returns null when there is nothing to report (no empty digests). */
export function buildDigest(
	counts: DigestCounts,
	alerts: AlertToggles | null | undefined,
	baseUrl?: string,
): Digest | null {
	const lines = buildDigestLines(counts, alerts);
	if (lines.length === 0) return null;
	const origin = baseUrl?.replace(/\/+$/, "") ?? "";
	const body = lines
		.map((line) => `• ${line.text}${origin ? ` — ${origin}${line.link}` : ""}`)
		.join("\n");
	return {
		title: `${appName}: ${plural(lines.length, "item")} need attention`,
		body: body.slice(0, 3500),
		lines,
		total: lines.length,
	};
}

/** Local date and hour for `now` in an IANA zone (falls back to UTC). */
export function localClock(now: Date, timeZone: string) {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		}).formatToParts(now);
	} catch {
		return localClock(now, "UTC");
	}
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		hour: Number(get("hour")) % 24,
	};
}

/** Whether the digest is due: at/after the chosen local hour, once per local day. */
export function digestDue(input: {
	now: Date;
	timeZone: string;
	digestHour: number;
	lastDigestDate: string | null;
}) {
	const clock = localClock(input.now, input.timeZone);
	return {
		due: clock.hour >= input.digestHour && input.lastDigestDate !== clock.date,
		localDate: clock.date,
	};
}

export function isValidTimeZone(timeZone: string) {
	try {
		new Intl.DateTimeFormat("en", { timeZone });
		return true;
	} catch {
		return false;
	}
}
