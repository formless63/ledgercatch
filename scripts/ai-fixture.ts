import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { setImmediate as nextTurn } from "node:timers/promises";
import { z } from "zod";
import { type AiConfig, AiError, createAi } from "../src/integrations/ai/ai.server";

export async function runAiFixture(factory: typeof createAi = createAi) {
 const requests: { mode: string; body: Record<string, unknown>; authorization?: string; inheritedHeaders: (string | string[] | undefined)[] }[] = [];
 let disconnected = 0, completedStreams = 0;
 const timers = new Set<ReturnType<typeof setTimeout>>();
 const unhandled: unknown[] = [];
 const onUnhandled = (error: unknown) => { unhandled.push(error); };
 process.on("unhandledRejection", onUnhandled);
 const server = createServer(async (req, res) => {
  const buffers: Buffer[] = [];
  for await (const buffer of req) buffers.push(buffer);
  const body = JSON.parse(Buffer.concat(buffers).toString());
  const mode = body.messages[0].content;
  requests.push({ mode, body, authorization: req.headers.authorization, inheritedHeaders: [req.headers["openai-organization"], req.headers["openai-project"], req.headers["x-fixture-inherited"]] });
  assert.equal(req.url, "/v1/chat/completions");
  res.on("close", () => { if (!res.writableEnded) disconnected++; });
  if (["auth", "rate", "unavailable", "bad-request"].includes(mode)) {
   res.writeHead(({ auth: 401, rate: 429, unavailable: 503, "bad-request": 400 } as Record<string, number>)[mode], { "content-type": "application/json" });
   res.end(JSON.stringify({ error: { message: "fixture-private-key PROMPT PRIVATE OUTPUT", type: "fixture", code: "fixture" } })); return;
  }
  if (mode === "oversized-error-envelope") {
   res.writeHead(503, { "content-type": "application/json" });
   res.write(JSON.stringify({ error: { message: "fixture-private-key PROMPT PRIVATE OUTPUT", padding: "x".repeat(32 * 1024 * 1024) } })); return;
  }
  if (mode === "stall") { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); return; }
  if (mode === "malformed-envelope") { res.writeHead(200, { "content-type": "application/json" }); res.end('{broken'); return; }
  if (["oversized-envelope", "oversized-unterminated-envelope"].includes(mode)) {
   res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
   // Valid small output inside an oversized JSON/SSE envelope; leave the socket open.
   const envelope = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "{}" }, delta: { content: "x" }, finish_reason: "stop" }], padding: "x".repeat(32 * 1024 * 1024) });
   res.write(body.stream ? mode === "oversized-unterminated-envelope" ? `data: ${envelope.slice(0, -1)}` : `data: ${envelope}\n\n` : envelope); return;
  }
  const tokens = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  if (body.stream) {
   res.writeHead(200, { "content-type": "text/event-stream" });
   const chunk = (content: string | null, reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: reason }] })}\n\n`);
   if (mode === "oversized") { chunk("x".repeat(1024 * 1024 + 1)); return; }
   if (mode === "accumulated-oversized") { for (let index = 0; index < 17; index++) chunk("é".repeat(32768)); return; }
   const protocolDeltas: Record<string, string[]> = {
    "split-surrogate": ["a\ud83d", "", "\ude00b\udbff", "\udfff"],
    "split-surrogate-boundary": ["x".repeat(1024 * 1024 - 4), "\ud83d", "", "\ude00"],
    "split-surrogate-oversized": ["x".repeat(1024 * 1024 - 3), "\ud83d", "\ude00"],
    "dangling-surrogate": ["\ud83d"],
    "lone-low-surrogate": ["\ude00"],
    "interrupted-surrogate": ["\ud83d", "x"],
   };
   if (protocolDeltas[mode]) {
    for (const text of protocolDeltas[mode]) chunk(text);
    chunk(null, "stop"); res.end("data: [DONE]\n\n"); return;
   }
   if (["missing-finish", "duplicate-finish", "text-after-finish"].includes(mode)) {
    chunk("hello");
    if (mode !== "missing-finish") chunk(null, "stop");
    if (mode === "duplicate-finish") chunk(null, "stop");
    if (mode === "text-after-finish") chunk("late");
    res.end("data: [DONE]\n\n"); return;
   }
   chunk("hello ");
   if (mode === "stream-stall") return;
   const timer = setTimeout(() => {
    timers.delete(timer);
    if (res.destroyed) return;
    if (mode === "stream-failure") { res.write('data: {broken}\n\n'); res.end(); return; }
    chunk("world"); chunk(null, "stop");
    res.write(`data: ${JSON.stringify({ choices: [], usage: tokens })}\n\n`);
    completedStreams++;
    res.end("data: [DONE]\n\n");
   }, 80);
   timers.add(timer);
   return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  const text = mode === "structured" || mode.startsWith("finish-") ? '{"answer":42}' : mode === "malformed" ? '{broken' : mode === "schema-invalid" ? '{"answer":"private-output"}' : mode === "oversized" ? "x".repeat(1024 * 1024 + 1) : mode === "boundary" ? "x".repeat(1024 * 1024) : "hello world";
  const reason = mode === "missing-finish" ? null : mode.startsWith("finish-") ? mode.slice("finish-".length) : "stop";
  res.end(JSON.stringify({ id: "fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: reason }], usage: mode === "bad-usage" ? { prompt_tokens: -1, completion_tokens: 1.5, total_tokens: Infinity } : tokens }));
 });
 await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
 const address = server.address(); assert.ok(address && typeof address === "object");
 const selectedSdkEnvironment = {
  OPENAI_API_KEY: "fixture-inherited-key", OPENAI_ADMIN_KEY: "fixture-inherited-admin",
  OPENAI_BASE_URL: "http://127.0.0.1:1/should-never-be-used",
  OPENAI_ORG_ID: "fixture-inherited-org", OPENAI_PROJECT_ID: "fixture-inherited-project",
  OPENAI_CUSTOM_HEADERS: "Authorization: Bearer fixture-inherited-header\nX-Fixture-Inherited: private-header",
  OPENAI_LOG: "debug", NODE_ENV: "test",
 };
 const previous = Object.fromEntries(Object.keys(selectedSdkEnvironment).map(key => [key, process.env[key]]));
 Object.assign(process.env, selectedSdkEnvironment);
 const config: AiConfig = { provider: "openai-compatible", model: "fixture-model", baseUrl: `http://127.0.0.1:${address.port}/v1`, timeoutSeconds: 1 };
 const ai = factory(config);
 const input = (mode: string, signal?: AbortSignal) => ({ messages: [{ role: "user" as const, content: mode }], ...(signal ? { signal } : {}) });
 const fails = async (work: Promise<unknown>, code: string) => assert.rejects(work, (error: unknown) => {
  assert.ok(error instanceof AiError); assert.equal(error.code, code);
  for (const value of [JSON.stringify(error), inspect(error)]) assert.ok(!/fixture-private-key|PROMPT PRIVATE|private-output|http:\/\//.test(value));
  return true;
 });
 const closed = async (before: number) => {
  const until = Date.now() + 2000;
  while (disconnected <= before && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(disconnected > before, "operation must abort the real socket");
 };
 try {
  assert.equal(requests.length, 0);
  await fails(ai.generateText(input("ordinary", Object.create(AbortSignal.prototype))), "invalid-request");
  for (const apiKey of [" key", "key "]) await fails(factory({ ...config, apiKey }).generateText(input("ordinary")), "configuration");
  assert.equal(requests.length, 0);
  const ordinary = await ai.generateText({ ...input("ordinary"), temperature: 0, maxOutputTokens: 1 });
  assert.deepEqual(ordinary, { text: "hello world", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
  assert.equal(requests[0].authorization, undefined);
  assert.equal(requests[0].body.model, "fixture-model"); assert.equal(requests[0].body.max_tokens, 1); assert.equal(requests[0].body.temperature, 0);
  const authAi = factory({ ...config, apiKey: "fixture-api-key" }); await authAi.generateText(input("ordinary"));
  assert.equal(requests.at(-1)?.authorization, "Bearer fixture-api-key");
  assert.equal((await ai.generateText(input("boundary"))).text.length, 1024 * 1024);
  assert.equal((await ai.generateText(input("bad-usage"))).usage, undefined);
  assert.deepEqual((await ai.generateStructured(input("structured"), z.object({ answer: z.number() }))).object, { answer: 42 });
  assert.deepEqual(requests.at(-1)?.body.response_format, { type: "json_object" });
  await fails(ai.generateStructured(input("malformed"), z.object({ answer: z.number() })), "invalid-output");
  await fails(ai.generateStructured(input("schema-invalid"), z.object({ answer: z.number() })), "invalid-output");
  await fails(ai.generateStructured(input("oversized"), z.unknown()), "invalid-output");
  await fails(ai.generateText(input("missing-finish")), "invalid-output");
  await fails(ai.generateText(input("malformed-envelope")), "invalid-output");
  for (const [providerReason, publicReason] of [["length", "length"], ["content_filter", "content-filter"], ["tool_calls", "other"]]) {
   assert.equal((await ai.generateText(input(`finish-${providerReason}`))).finishReason, publicReason);
   let validated = false;
   const schema = z.object({ answer: z.number() }).refine(() => { validated = true; return true; });
   await fails(ai.generateStructured(input(`finish-${providerReason}`), schema), "invalid-output");
   assert.equal(validated, false, "incomplete structured output must not reach application validation");
  }
  for (const cancel of [false, true]) {
   const controller = new AbortController();
   let release!: () => void;
   const waiting = new Promise<void>(resolve => { release = resolve; });
   let entered!: () => void;
   const refining = new Promise<void>(resolve => { entered = resolve; });
   const schema = z.object({ answer: z.number() }).refine(async () => { entered(); await waiting; throw new Error("private-output late validation failure"); });
   const result = fails(ai.generateStructured(input("structured", controller.signal), schema), cancel ? "cancelled" : "timeout");
   await refining;
   if (cancel) controller.abort();
   // Release after the operation deadline to prove validation shares the scope.
   const timer = setTimeout(release, 1100); timers.add(timer);
   try { await result; } finally { clearTimeout(timer); timers.delete(timer); release(); }
   await nextTurn();
  }
  await fails(ai.generateStructured(input("structured"), z.object({ answer: z.number() }).refine(async () => new Promise<boolean>(() => {}))), "timeout");
  assert.deepEqual((await ai.generateStructured(input("structured"), z.object({ answer: z.number() }).refine(async () => { await nextTurn(); return true; }))).object, { answer: 42 });
  for (const [mode, code] of [["auth", "authentication"], ["rate", "rate-limit"], ["unavailable", "unavailable"], ["bad-request", "invalid-request"], ["oversized", "invalid-output"]]) {
   const before: number = requests.length; await fails(ai.generateText(input(mode)), code); assert.equal(requests.length, before + 1, "no retry");
  }
  const streamCount = completedStreams;
  const stream = ai.streamText(input("ordinary"));
  assert.deepEqual((await stream.next()).value, { type: "text-delta", text: "hello " });
  assert.equal(completedStreams, streamCount, "first delta delivered before server completes");
  const events = []; for await (const event of stream) events.push(event);
  assert.deepEqual(events, [{ type: "text-delta", text: "world" }, { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }]);
  const collect = async (mode: string) => { const events = []; for await (const event of ai.streamText(input(mode))) events.push(event); return events; };
  const drain = async (mode: string) => { const events = []; try { for await (const event of ai.streamText(input(mode))) events.push(event); } catch (error) { assert.ok(!events.some(event => event.type === "finish"), "failed stream must not emit success"); throw error; } };
  for (const [mode, text] of [["split-surrogate", "a😀b\udbff\udfff"], ["split-surrogate-boundary", "x".repeat(1024 * 1024 - 4) + "😀"]]) {
   const events = await collect(mode);
   assert.equal(events.filter(event => event.type === "finish").length, 1);
   assert.equal(events.flatMap(event => event.type === "text-delta" ? [event.text] : []).join(""), text);
   assert.ok(new TextEncoder().encode(text).byteLength <= 1024 * 1024);
  }
  for (const mode of ["split-surrogate-oversized", "dangling-surrogate", "lone-low-surrogate", "interrupted-surrogate", "missing-finish", "duplicate-finish", "text-after-finish"])
   await fails(drain(mode), "invalid-output");
  for (const work of [() => ai.generateText(input("oversized-error-envelope")), () => ai.generateStructured(input("oversized-error-envelope"), z.unknown()), () => drain("oversized-error-envelope"), () => ai.generateText(input("oversized-envelope")), () => ai.generateStructured(input("oversized-envelope"), z.unknown()), () => drain("oversized-envelope"), () => drain("oversized-unterminated-envelope")]) {
   const before = disconnected, count: number = requests.length;
   await fails(work(), "invalid-output"); await closed(before);
   assert.equal(requests.length, count + 1, "oversized envelopes must not retry");
  }
  await fails(drain("stream-failure"), "invalid-output");
  await fails(drain("accumulated-oversized"), "invalid-output");
  let before = disconnected; await fails(drain("oversized"), "invalid-output"); await closed(before);
  for (const mode of ["stall", "stream-stall"]) {
   before = disconnected; const started = Date.now();
   await fails(mode === "stall" ? ai.generateText(input(mode)) : drain(mode), "timeout");
   assert.ok(Date.now() - started < 2500); await closed(before);
  }
  for (const mode of ["stall", "stream-stall"]) {
   const controller = new AbortController(); before = disconnected;
   const work = mode === "stall" ? ai.generateText(input(mode, controller.signal)) : (async () => { for await (const _event of ai.streamText(input(mode, controller.signal))) {} })();
   const result = fails(work, "cancelled");
   await new Promise(resolve => setTimeout(resolve, 40)); controller.abort(); await result; await closed(before);
  }
  before = disconnected; const paused = ai.streamText(input("stream-stall")); await paused.next();
  await new Promise(resolve => setTimeout(resolve, 1100)); await closed(before); await fails(paused.next(), "timeout");
  before = disconnected; const cancelled = ai.streamText(input("stream-stall")); await cancelled.next(); await cancelled.return?.(); await closed(before);
  before = disconnected; const pending = ai.streamText(input("stream-stall")); await pending.next(); const next = fails(pending.next(), "cancelled"); const returned = pending.return?.(); await next; await returned; await closed(before);
  const controller = new AbortController(); controller.abort(); const count = requests.length;
  await fails(ai.generateText(input("ordinary", controller.signal)), "cancelled"); assert.equal(requests.length, count);
  const invalidCount = requests.length; await fails(ai.generateText({ messages: [] }), "invalid-request"); assert.equal(requests.length, invalidCount);
  await fails(ai.generateText({ ...input("ordinary"), signal: {} as AbortSignal }), "invalid-request"); assert.equal(requests.length, invalidCount);
  assert.ok(requests.every(request => request.inheritedHeaders.every(header => header === undefined)), "SDK environment must not add outbound headers");
  assert.ok(requests.every(request => request.authorization === undefined || request.authorization === "Bearer fixture-api-key"), "SDK environment must not supply credentials");
  await nextTurn(); await nextTurn(); assert.deepEqual(unhandled, [], "no dangling rejection from transport, validation or instrumentation");
 } finally {
  process.off("unhandledRejection", onUnhandled);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const timer of timers) clearTimeout(timer);
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
 }
 console.info("AI local HTTP fixture passed: completion, streaming, structured validation, safe errors, no retries, limits and real socket cancellation");
}
