/** Pure asset-register helpers (#13): warranty dates, filters, CSV. */
import type { AssetStatus } from "./schema";

/** Purchase date + N months (end-of-month clamped), ISO YYYY-MM-DD. */
export function addMonths(isoDate: string, months: number): string {
	const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
	const target = new Date(Date.UTC(y, m - 1 + months, 1));
	const lastDay = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
	).getUTCDate();
	target.setUTCDate(Math.min(d, lastDay));
	return target.toISOString().slice(0, 10);
}

export function warrantyExpiry(input: {
	purchaseDate: string | null | undefined;
	warrantyMonths: number | null | undefined;
	warrantyExpiresAt?: string | null;
}): string | null {
	if (input.warrantyExpiresAt) return input.warrantyExpiresAt;
	if (!input.purchaseDate || !input.warrantyMonths) return null;
	return addMonths(input.purchaseDate, input.warrantyMonths);
}

export type WarrantyState = "none" | "active" | "expiring" | "expired";

export function warrantyState(
	expiresAt: string | null,
	today: string,
	soonDays = 60,
): WarrantyState {
	if (!expiresAt) return "none";
	if (expiresAt < today) return "expired";
	const days =
		(Date.parse(`${expiresAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
		86_400_000;
	return days <= soonDays ? "expiring" : "active";
}

export type AssetCsvRow = {
	name: string;
	serial: string | null;
	status: AssetStatus;
	entityName: string | null;
	purchaseDate: string | null;
	warrantyMonths: number | null;
	warrantyExpiresAt: string | null;
	location: string | null;
	source: string | null;
	externalOrderId: string | null;
	unitPriceMinor: number | null;
	currency: string | null;
	notes: string | null;
};

const decimal = (minor: number | null) => {
	if (minor == null) return "";
	const sign = minor < 0 ? "-" : "";
	const abs = Math.abs(minor);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

function csvCell(value: string | number | null | undefined): string {
	const text = value == null ? "" : String(value);
	// Guard against spreadsheet formula injection.
	const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function assetsToCsv(rows: AssetCsvRow[]): string {
	const header = [
		"Name",
		"Serial",
		"Status",
		"Entity",
		"Purchase date",
		"Warranty months",
		"Warranty expires",
		"Location",
		"Store",
		"Order ID",
		"Unit price",
		"Currency",
		"Notes",
	];
	const lines = rows.map((r) => [
		r.name,
		r.serial,
		r.status,
		r.entityName,
		r.purchaseDate,
		r.warrantyMonths,
		r.warrantyExpiresAt,
		r.location,
		r.source,
		r.externalOrderId,
		decimal(r.unitPriceMinor),
		r.currency,
		r.notes,
	]);
	return [header, ...lines]
		.map((line) => line.map(csvCell).join(","))
		.join("\r\n");
}
