/** ISO capture time retaining the client's offset instead of normalizing to UTC. */
export function formatCaptureTimestamp(
	date = new Date(),
	timezoneOffsetMinutes = date.getTimezoneOffset(),
): string {
	const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
	const offset = Math.abs(timezoneOffsetMinutes);
	const hours = String(Math.floor(offset / 60)).padStart(2, "0");
	const minutes = String(offset % 60).padStart(2, "0");
	return `${local.toISOString().slice(0, -1)}${timezoneOffsetMinutes > 0 ? "-" : "+"}${hours}:${minutes}`;
}

/**
 * An explicit offset preserves the capture's local calendar date. A legacy
 * `Z` timestamp supplies an instant only; the client's local date is unknown.
 */
export function captureLocalDate(capturedAt: string): string | undefined {
	if (!/[+-]\d{2}:\d{2}$/.test(capturedAt)) return undefined;
	if (!/^\d{4}-\d{2}-\d{2}T/.test(capturedAt)) return undefined;
	if (!Number.isFinite(Date.parse(capturedAt))) return undefined;
	return capturedAt.slice(0, 10);
}
