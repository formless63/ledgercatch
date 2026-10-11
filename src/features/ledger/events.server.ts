import { sql } from "drizzle-orm";
import { db } from "#/db";

/**
 * Change hints for live UI refresh. The worker and web app are separate
 * processes, so hints travel through PostgreSQL NOTIFY; the web process
 * relays them to connected browsers. Payloads carry ids only.
 */
export type LedgerEvent =
	| { type: "capture"; captureId: string }
	| { type: "orders"; orderIds: string[]; created: number };

export const LEDGER_CHANNEL = "ledger_events";

export function publishLedgerEvent(ownerId: string, event: LedgerEvent) {
	const payload = JSON.stringify({
		ownerId,
		...event,
		...(event.type === "orders"
			? { orderIds: event.orderIds.slice(0, 50) }
			: {}),
	});
	// Best effort: a missed hint only delays a refresh.
	db.execute(sql`select pg_notify(${LEDGER_CHANNEL}, ${payload})`).catch(
		() => {},
	);
}
