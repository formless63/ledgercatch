import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import nodeAdapter from "crossws/adapters/node";
import { z } from "zod";
import { createRealtime, defineRealtimeEvents, openSocket, openSse } from "../src/integrations/realtime/realtime.server";
const registry = defineRealtimeEvents({ "fixture.event": z.strictObject({ value: z.string() }) }), realtime = createRealtime(registry);
const connections = new Map<string, ReturnType<typeof openSocket>>();
const nativePeers = new Map<string, { bufferedAmount: number }>();
// This disposable protocol fixture substitutes application authorization; production uses Better Auth.
const authorize = (url: string, headers: Headers) => {
  const query = new URL(url).searchParams;
  if (headers.get("cookie") !== "session=fixture-human" || headers.has("authorization") || headers.has("x-api-key") || query.size > 0) throw new Response("Unauthorized", { status: 401 });
  return ["fixture"];
};
const adapter = nodeAdapter({ idleTimeout: 0, hooks: {
  upgrade(request) { return { context: { channels: authorize(request.url, request.headers) } }; },
  open(peer) { nativePeers.set(peer.id, peer); connections.set(peer.id, openSocket(realtime, peer.context.channels as string[], peer)); },
  pong(peer) { connections.get(peer.id)?.pong(); },
  message(peer) { connections.get(peer.id)?.close(); },
  close(peer) { connections.get(peer.id)?.close(); connections.delete(peer.id); nativePeers.delete(peer.id); },
  error(peer) { connections.get(peer.id)?.close(); connections.delete(peer.id); },
} });
const server = createServer(async (req, res) => {
  const abort = new AbortController(); res.on("close", () => abort.abort());
  try {
    const response = openSse(realtime, authorize(`http://127.0.0.1${req.url}`, new Headers(req.headers as Record<string,string>)), abort.signal);
    res.writeHead(200, Object.fromEntries(response.headers)); res.flushHeaders();
    if (!response.body) throw new Error(); await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
  } catch { if (!res.headersSent) { res.writeHead(401); res.end("Unauthorized"); } }
});
server.on("upgrade", (req, socket, head) => adapter.handleUpgrade(req, socket, head));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const controller = new AbortController();
try {
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}?channel=foreign`, { headers: { cookie: "session=fixture-human" } })).status, 401);
  assert.equal((await fetch(`${base}?token=private`, { headers: { cookie: "session=fixture-human" } })).status, 401);
  const response = await fetch(base, { headers: { cookie: "session=fixture-human" }, signal: controller.signal }); const reader = response.body?.getReader(); assert.ok(reader);
  assert.equal(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
  // CrossWS's Node client permits headers for fixture cookie authentication; browser auth uses native cookies.
  const { default: CrosswsWebSocket } = await import("crossws/websocket");
  const WebSocket = CrosswsWebSocket as unknown as { new(url: string, protocols: string[], options: { headers: Record<string,string> }): globalThis.WebSocket };
  const ws = new WebSocket(base.replace("http:", "ws:"), [], { headers: { cookie: "session=fixture-human" } });
  await new Promise<void>((resolve,reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", reject, { once: true }); });
  const socketMessage = new Promise<string>(resolve => ws.addEventListener("message", event => resolve(String(event.data)), { once: true }));
  const event = realtime.publish("fixture", "fixture.event", { value: "same envelope" });
  assert.equal(await socketMessage, event.body); assert.equal(new TextDecoder().decode((await reader.read()).value), `event: fixture.event\ndata: ${event.body}\n\n`);
  const heartbeat = await reader.read(); assert.equal(new TextDecoder().decode(heartbeat.value), ": heartbeat\n\n");
  // Survive the next heartbeat: native Node client automatically responds to ping.
  await reader.read(); assert.equal(ws.readyState, 1);
  ws.close(); controller.abort();
  for (let i=0; i<50 && realtime.activeConnections; i++) await new Promise(r => setTimeout(r,20)); assert.equal(realtime.activeConnections, 0);
  const slow = new WebSocket(base.replace("http:", "ws:"), [], { headers: { cookie: "session=fixture-human" } });
  await new Promise<void>((resolve,reject) => { slow.addEventListener("open",()=>resolve(),{once:true}); slow.addEventListener("error",reject,{once:true}); });
  const socket = (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket; assert.ok(socket); socket.pause();
  let peak = 0;
  for (let i=0;i<2048 && realtime.activeConnections;i++) {
    realtime.publish("fixture","fixture.event",{value:"x".repeat(60000)});
    for (const peer of nativePeers.values()) peak=Math.max(peak,peer.bufferedAmount);
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.ok(peak>0,"Deliberately paused actual client must stall native output"); assert.ok(peak<=262144,"Native pending output never exceeds 256KiB"); assert.equal(realtime.activeConnections,0,"Stalled socket closes instead of accumulating"); socket.resume(); slow.close();
  console.info("Actual Node SSE and WebSocket authenticated transport, envelope parity, 20s heartbeat/native pong and disconnect cleanup verified");
} finally { controller.abort(); realtime.close(); await adapter.close(); server.closeAllConnections(); server.close(); await once(server, "close"); }
