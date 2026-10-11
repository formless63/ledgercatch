/** Client-safe formatting helpers and display metadata. */
import type { StoreId } from "#/shared/capture";

const exponentCache = new Map<string, number>();
function exponent(currency: string) {
	const cached = exponentCache.get(currency);
	if (cached !== undefined) return cached;
	let digits = 2;
	try {
		digits =
			new Intl.NumberFormat("en", {
				style: "currency",
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		digits = 2;
	}
	exponentCache.set(currency, digits);
	return digits;
}

/** Minor units → localized currency string ("$1,234.50"). */
export function formatMoney(
	minor: number | null | undefined,
	currency: string | null | undefined,
	options: { compact?: boolean; signed?: boolean } = {},
): string {
	if (minor == null) return "—";
	const code = (currency || "USD").toUpperCase();
	const value = minor / 10 ** exponent(code);
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: code,
			notation: options.compact ? "compact" : "standard",
			maximumFractionDigits: options.compact ? 1 : undefined,
			signDisplay: options.signed ? "exceptZero" : "auto",
		}).format(value);
	} catch {
		return `${value.toFixed(2)} ${code}`;
	}
}

export function formatDate(
	value: string | null | undefined,
	style: "short" | "long" = "short",
) {
	if (!value) return "—";
	const date =
		value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString(undefined, {
		year: style === "long" ? "numeric" : "2-digit",
		month: "short",
		day: "numeric",
	});
}

export function formatRelative(value: string | null | undefined) {
	if (!value) return "—";
	const diff = Date.now() - new Date(value).getTime();
	const minutes = Math.round(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 60) return `${days}d ago`;
	return formatDate(value);
}

export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const STORE_META: Record<StoreId, { label: string; short: string }> = {
	amazon: { label: "Amazon", short: "AMZ" },
	aliexpress: { label: "AliExpress", short: "ALX" },
	alibaba: { label: "Alibaba", short: "ALB" },
	ebay: { label: "eBay", short: "EBY" },
	digikey: { label: "DigiKey", short: "DGK" },
	mouser: { label: "Mouser", short: "MSR" },
	generic: { label: "Other store", short: "WEB" },
};

export function storeLabel(source: string) {
	return STORE_META[source as StoreId]?.label ?? source;
}

/** Entity palette (docs/DESIGN.md). Classes are literal for Tailwind scanning. */
export const ENTITY_STYLES: Record<
	string,
	{ dot: string; chip: string; bar: string; text: string; hex: string }
> = {
	indigo: {
		dot: "bg-indigo-400",
		chip: "border-indigo-400/35 bg-indigo-500/12 text-indigo-700 dark:text-indigo-300",
		bar: "bg-indigo-400",
		text: "text-indigo-600 dark:text-indigo-300",
		hex: "#818cf8",
	},
	emerald: {
		dot: "bg-emerald-400",
		chip: "border-emerald-400/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
		bar: "bg-emerald-400",
		text: "text-emerald-600 dark:text-emerald-300",
		hex: "#34d399",
	},
	sky: {
		dot: "bg-sky-400",
		chip: "border-sky-400/35 bg-sky-500/12 text-sky-700 dark:text-sky-300",
		bar: "bg-sky-400",
		text: "text-sky-600 dark:text-sky-300",
		hex: "#38bdf8",
	},
	purple: {
		dot: "bg-purple-400",
		chip: "border-purple-400/35 bg-purple-500/12 text-purple-700 dark:text-purple-300",
		bar: "bg-purple-400",
		text: "text-purple-600 dark:text-purple-300",
		hex: "#c084fc",
	},
	amber: {
		dot: "bg-amber-400",
		chip: "border-amber-400/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
		bar: "bg-amber-400",
		text: "text-amber-600 dark:text-amber-300",
		hex: "#fbbf24",
	},
	pink: {
		dot: "bg-pink-400",
		chip: "border-pink-400/35 bg-pink-500/12 text-pink-700 dark:text-pink-300",
		bar: "bg-pink-400",
		text: "text-pink-600 dark:text-pink-300",
		hex: "#f472b6",
	},
	teal: {
		dot: "bg-teal-400",
		chip: "border-teal-400/35 bg-teal-500/12 text-teal-700 dark:text-teal-300",
		bar: "bg-teal-400",
		text: "text-teal-600 dark:text-teal-300",
		hex: "#2dd4bf",
	},
};

export type Tone =
	| "success"
	| "warning"
	| "info"
	| "danger"
	| "neutral"
	| "primary";

export const TONE_CLASSES: Record<Tone, string> = {
	success:
		"border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
	warning:
		"border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-400",
	info: "border-cyan-500/30 bg-cyan-500/12 text-cyan-700 dark:text-cyan-400",
	danger: "border-red-500/30 bg-red-500/12 text-red-700 dark:text-red-400",
	neutral: "border-border bg-muted text-muted-foreground",
	primary: "border-primary/35 bg-primary/12 text-primary",
};

export const REIMBURSEMENT_TONES: Record<
	string,
	{ tone: Tone; label: string }
> = {
	none: { tone: "neutral", label: "Not reimbursable" },
	pending: { tone: "warning", label: "Pending claim" },
	submitted: { tone: "info", label: "Claim submitted" },
	reimbursed: { tone: "success", label: "Reimbursed" },
	rejected: { tone: "danger", label: "Rejected" },
};

export const ORDER_STATUS_TONES: Record<string, Tone> = {
	placed: "primary",
	processing: "primary",
	shipped: "info",
	delivered: "success",
	cancelled: "danger",
	returned: "warning",
	unknown: "neutral",
};

export const CAPTURE_STATUS_TONES: Record<string, Tone> = {
	pending: "primary",
	parsed: "success",
	no_orders: "neutral",
	needs_review: "warning",
	failed: "danger",
	ignored: "neutral",
};
