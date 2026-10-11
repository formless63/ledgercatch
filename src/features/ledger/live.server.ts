/**
 * Relays worker change hints (PostgreSQL NOTIFY on `ledger_events`) to the
 * web process's realtime hub, so open browsers refetch instead of polling.
 * Started lazily by the SSE route; one listener per process.
 */
import pg from "pg";
import {
	applicationRealtime,
	recipientChannel,
} from "../../lib/realtime-hub.server";

// Must match LEDGER_CHANNEL in events.server.ts (kept separate to avoid importing the DB client here).
const LEDGER_CHANNEL = "ledger_events";

const state = globalThis as typeof globalThis & {
	__ledgerRelay?: Promise<void>;
};

async function connect(): Promise<void> {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	client.on("notification", (message) => {
		if (message.channel !== LEDGER_CHANNEL || !message.payload) return;
		try {
			const hint = JSON.parse(message.payload) as {
				ownerId?: string;
				type?: string;
			};
			if (!hint.ownerId) return;
			applicationRealtime.publish(
				recipientChannel(hint.ownerId),
				"ledger.changed",
				{
					kind:
						typeof hint.type === "string" ? hint.type.slice(0, 64) : undefined,
				},
			);
		} catch {
			/* malformed hint: ignore */
		}
	});
	const restart = () => {
		state.__ledgerRelay = undefined;
		client.end().catch(() => {});
		setTimeout(() => void ensureLedgerRelay(), 5_000);
	};
	client.on("error", restart);
	client.on("end", () => {
		if (state.__ledgerRelay) restart();
	});
	await client.connect();
	await client.query(`LISTEN ${LEDGER_CHANNEL}`);
}

export function ensureLedgerRelay() {
	state.__ledgerRelay ??= connect().catch(() => {
		state.__ledgerRelay = undefined;
	});
	return state.__ledgerRelay;
}
