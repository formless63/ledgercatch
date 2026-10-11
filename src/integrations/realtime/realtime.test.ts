import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	authorizedChannels,
	createRealtime,
	defineRealtimeEvents,
	encodeEvent,
	openSocket,
	openSse,
	realtimeTransports,
} from "./realtime.server";

afterEach(() => vi.restoreAllMocks());
function clock() {
	let tick = () => {};
	const clear = vi
		.spyOn(globalThis, "clearInterval")
		.mockImplementation(() => {});
	vi.spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		milliseconds: number,
	) => {
		expect(milliseconds).toBe(20000);
		tick = callback;
		return { unref() {} };
	}) as unknown as typeof setInterval);
	return { tick: () => tick(), clear };
}
const registry = defineRealtimeEvents({
	"fixture.event": z.strictObject({ message: z.string() }),
});
describe("realtime contracts", () => {
	it("chooses SSE, WebSocket or both, rejects duplicates/unknown configuration", () => {
		expect([...realtimeTransports("sse")]).toEqual(["sse"]);
		expect([...realtimeTransports("websocket")]).toEqual(["websocket"]);
		expect([...realtimeTransports(" SSE, WebSocket ")]).toEqual([
			"sse",
			"websocket",
		]);
		for (const value of ["", "sse,sse", "socketio", "sse,"])
			expect(() => realtimeTransports(value)).toThrow();
		expect(
			authorizedChannels(Array.from({ length: 32 }, (_, i) => `channel:${i}`)),
		).toHaveLength(32);
		for (const channels of [
			["*"],
			["valid", "valid"],
			Array.from({ length: 33 }, (_, i) => `channel:${i}`),
		])
			expect(() => authorizedChannels(channels)).toThrow();
	});
	it("validates Zod output and exact encoded 64KiB envelope bounds", () => {
		const encoded = encodeEvent(registry, "fixture.event", { message: "hi" });
		const event = JSON.parse(encoded.body);
		expect(Object.keys(event)).toEqual(["id", "type", "occurredAt", "data"]);
		expect(event.id).toMatch(/^[a-f0-9-]{36}$/);
		expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
		const overhead = encoded.bytes - 2;
		expect(
			encodeEvent(registry, "fixture.event", {
				message: "x".repeat(65536 - overhead),
			}).bytes,
		).toBe(65536);
		expect(() =>
			encodeEvent(registry, "fixture.event", {
				message: "x".repeat(65537 - overhead),
			}),
		).toThrow();
		const getter = Object.defineProperty({}, "x", {
			enumerable: true,
			get() {
				throw new Error("must not run");
			},
		});
		const customArray = [1];
		delete customArray[0];
		Object.assign(customArray, { hidden: 1 });
		for (const value of [
			new Date(),
			new Error(),
			new (class Value {})(),
			undefined,
			BigInt(1),
			() => 1,
			NaN,
			getter,
			customArray,
			[undefined],
		]) {
			const transformed = defineRealtimeEvents({
				"fixture.output": z.unknown().transform(() => value),
			});
			expect(() => encodeEvent(transformed, "fixture.output", {})).toThrow();
		}
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(() =>
			encodeEvent(
				defineRealtimeEvents({ "fixture.output": z.unknown() }),
				"fixture.output",
				cyclic,
			),
		).toThrow();
	});
	it("uses SSE event/data only, 20s comment heartbeat, abort cleanup and no history", async () => {
		const time = clock();
		const realtime = createRealtime(registry),
			abort = new AbortController();
		const response = openSse(realtime, ["fixture"], abort.signal);
		const reader = response.body?.getReader();
		if (!reader) throw new Error();
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("cache-control")).toBe("no-cache");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			": connected\n\n",
		);
		realtime.publish("fixture", "fixture.event", { message: "before" });
		const wire = new TextDecoder().decode((await reader.read()).value);
		expect(wire).toMatch(/^event: fixture.event\ndata: \{/);
		expect(wire).not.toContain("\nid:");
		time.tick();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			": heartbeat\n\n",
		);
		abort.abort();
		expect(realtime.activeConnections).toBe(0);
		await expect(reader.read()).rejects.toMatchObject({ code: "closed" });
		expect(time.clear).toHaveBeenCalled();
		const second = openSse(realtime, ["fixture"], new AbortController().signal);
		const other = second.body?.getReader();
		await other?.read();
		const pending = other?.read();
		realtime.publish("fixture", "fixture.event", { message: "after" });
		expect(new TextDecoder().decode((await pending)?.value)).toContain(
			'"after"',
		);
		await other?.cancel();
	});
	it("closes a stalled SSE reader before its encoded queue can exceed 256KiB", async () => {
		const realtime = createRealtime(registry);
		const response = openSse(
			realtime,
			["fixture"],
			new AbortController().signal,
		);
		for (let i = 0; i < 1000; i++)
			realtime.publish("fixture", "fixture.event", {
				message: "x".repeat(60000),
			});
		expect(realtime.activeConnections).toBe(0);
		const reader = response.body?.getReader();
		if (!reader) throw new Error();
		await expect(reader.read()).rejects.toMatchObject({ code: "backpressure" }); // Error discards the bounded queue immediately.
	});
	it("uses the same WS envelope, native heartbeat, dead-peer and stalled buffer cleanup", async () => {
		const time = clock();
		const realtime = createRealtime(registry);
		const send = vi.fn(),
			ping = vi.fn(),
			terminate = vi.fn();
		const peer = { bufferedAmount: 0, send, ping, terminate };
		const socket = openSocket(realtime, ["fixture"], peer);
		const event = realtime.publish("fixture", "fixture.event", {
			message: "hi",
		});
		expect(send).toHaveBeenCalledWith(event.body);
		time.tick();
		expect(ping).toHaveBeenCalledTimes(1);
		socket.pong();
		time.tick();
		expect(terminate).not.toHaveBeenCalled();
		time.tick();
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(realtime.activeConnections).toBe(0);
		expect(time.clear).toHaveBeenCalled();
		const slow = {
			bufferedAmount: 262140,
			send: vi.fn(),
			ping: vi.fn(),
			terminate: vi.fn(),
		};
		openSocket(realtime, ["fixture"], slow);
		realtime.publish("fixture", "fixture.event", { message: "slow" });
		expect(slow.send).not.toHaveBeenCalled();
		expect(slow.terminate).toHaveBeenCalledTimes(1);
		realtime.close();
		expect(() =>
			realtime.publish("fixture", "fixture.event", { message: "closed" }),
		).toThrow();
	});
});
