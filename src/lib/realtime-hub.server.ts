import { createHash } from "node:crypto";
import { z } from "zod";
import {
	createRealtime,
	defineRealtimeEvents,
} from "../integrations/realtime/realtime.server";
export const realtimeEvents = defineRealtimeEvents({
	// Payload-free change hints; clients refetch through authorized server functions.
	"ledger.changed": z.strictObject({ kind: z.string().max(64).optional() }),
});
// Nitro and Start use separate Vite module runners inside the same Node process.
// Share the application's process hub across those runners (also safe across production chunks).
const processState = globalThis as typeof globalThis & {
	__applicationRealtime?: ReturnType<
		typeof createRealtime<typeof realtimeEvents>
	>;
};
if (!processState.__applicationRealtime) {
	const hub = createRealtime(realtimeEvents);
	processState.__applicationRealtime = hub;
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => hub.close());
}
export const applicationRealtime = processState.__applicationRealtime;
export function recipientChannel(id: string) {
	// Stable opaque human IDs are hashed; auth tokens never become channel names.
	return `user:${createHash("sha256").update(id).digest("hex")}`;
}
