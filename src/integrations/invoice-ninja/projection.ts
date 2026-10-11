import { InvoiceNinjaError } from "./errors";
import { outputDecimal, parseExactJson } from "./json";
import type { InvoiceStatus } from "./schema";
import { hasControls, isWellFormed, opaqueId } from "./validation";

function record(v: unknown): Record<string, unknown> {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new InvoiceNinjaError("unsupported");
	return v as Record<string, unknown>;
}
export function entity(bytes: Uint8Array): Record<string, unknown> {
	return record(record(parseExactJson(bytes)).data);
}
export function remoteId(v: unknown): string {
	const r = opaqueId.safeParse(v);
	if (!r.success) throw new InvoiceNinjaError("unsupported");
	return r.data;
}
// Pinned Invoice model constants: STATUS_DRAFT=1, SENT=2, PARTIAL=3, PAID=4, CANCELLED=5, REVERSED=6.
const statuses: Record<string, InvoiceStatus> = {
	"1": "draft",
	"2": "sent",
	"3": "partial",
	"4": "paid",
	"5": "cancelled",
	"6": "reversed",
};
export function invoiceProjection(
	data: Record<string, unknown>,
	currency: () => string | null,
) {
	const id = remoteId(data.id);
	const number = data.number ?? null;
	if (
		number !== null &&
		(typeof number !== "string" ||
			number.length > 128 ||
			!isWellFormed(number) ||
			hasControls(number))
	)
		throw new InvoiceNinjaError("unsupported");
	const deleted = data.is_deleted === true;
	// Native Invoice Ninja invoices do not carry currency_id. The trusted
	// application resolves it from the bound client/company registry.
	const code = currency();
	if (code !== null && !/^[A-Z]{3}$/.test(code))
		throw new InvoiceNinjaError("unsupported");
	const updated = data.updated_at;
	let sourceUpdatedAt: Date | null = null;
	if (updated !== null && updated !== undefined) {
		if (typeof updated !== "string" || !/^\d{1,13}(\.\d{1,3})?$/.test(updated))
			throw new InvoiceNinjaError("unsupported");
		const [secs, fraction = ""] = updated.split(".");
		const millis = BigInt(secs) * 1000n + BigInt(fraction.padEnd(3, "0"));
		if (millis > 8640000000000000n) throw new InvoiceNinjaError("unsupported");
		sourceUpdatedAt = new Date(Number(millis));
	}
	return {
		remoteId: id,
		number,
		status: deleted
			? ("deleted" as const)
			: (statuses[String(data.status_id)] ?? "unknown"),
		currency: code,
		amount: outputDecimal(data.amount),
		balance: outputDecimal(data.balance),
		sourceUpdatedAt,
		syncedAt: new Date(),
		deleted,
	};
}
