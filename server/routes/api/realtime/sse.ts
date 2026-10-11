import { defineHandler } from "nitro";
import { openSse, RealtimeError } from "../../../../src/integrations/realtime/realtime.server";
import { applicationRealtime, authorizeRealtime } from "../../../../src/lib/realtime.server";
import { ensureLedgerRelay } from "../../../../src/features/ledger/live.server";
export default defineHandler(async event => {
  void ensureLedgerRelay();
  try { return openSse(applicationRealtime, await authorizeRealtime(event.req, "sse"), event.req.signal); }
  catch (error) { return new Response("Realtime unavailable", { status: error instanceof RealtimeError && error.code === "unauthorized" ? 401 : 503 }); }
});
