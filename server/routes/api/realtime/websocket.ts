import { realtimeWebsocket } from "../../../../src/integrations/realtime/websocket.server";
import { applicationRealtime, authorizeRealtime } from "../../../../src/lib/realtime.server";
export default realtimeWebsocket(applicationRealtime, request => authorizeRealtime(request, "websocket"));
