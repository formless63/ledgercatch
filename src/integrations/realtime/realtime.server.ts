import { randomUUID } from "node:crypto";
import type { z } from "zod";

export const REALTIME_LIMITS = {
	eventBytes: 65536,
	pendingBytes: 262144,
	channels: 32,
	heartbeatMs: 20000,
} as const;
export type RealtimeCode =
	| "configuration"
	| "invalid-input"
	| "unauthorized"
	| "unavailable"
	| "closed"
	| "backpressure";
export class RealtimeError extends Error {
	constructor(readonly code: RealtimeCode) {
		super(`Realtime ${code}`);
		this.name = "RealtimeError";
	}
}
export function realtimeTransports(
	value = process.env.REALTIME_TRANSPORTS ?? "sse",
): ReadonlySet<"sse" | "websocket"> {
	const values = value.split(",").map((v) => v.trim().toLowerCase());
	if (
		!values.length ||
		new Set(values).size !== values.length ||
		values.some((v) => v !== "sse" && v !== "websocket")
	)
		throw new RealtimeError("configuration");
	return new Set(values as ("sse" | "websocket")[]);
}
export function authorizedChannels(
	channels: readonly string[],
): readonly string[] {
	if (
		!Array.isArray(channels) ||
		!channels.length ||
		channels.length > 32 ||
		new Set(channels).size !== channels.length ||
		channels.some(
			(c) => typeof c !== "string" || !/^[a-z][a-z0-9._:/-]{0,127}$/.test(c),
		)
	)
		throw new RealtimeError("invalid-input");
	return [...channels];
}
function jsonSafe(input: unknown): void {
	const active = new Set<object>();
	const stack: { value: unknown; leave?: boolean }[] = [{ value: input }];
	let nodes = 0;
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		const value = item.value;
		if (item.leave) {
			active.delete(value as object);
			continue;
		}
		// A JSON tree with more nodes cannot fit the encoded 64KiB envelope anyway.
		if (++nodes > REALTIME_LIMITS.eventBytes)
			throw new RealtimeError("invalid-input");
		if (
			value === null ||
			typeof value === "boolean" ||
			typeof value === "string" ||
			(typeof value === "number" && Number.isFinite(value))
		)
			continue;
		if (typeof value !== "object" || !value || active.has(value))
			throw new RealtimeError("invalid-input");
		const array = Array.isArray(value),
			proto = Object.getPrototypeOf(value);
		if (
			proto !== (array ? Array.prototype : Object.prototype) &&
			!(proto === null && !array)
		)
			throw new RealtimeError("invalid-input");
		const descriptors = Object.getOwnPropertyDescriptors(value),
			entries = Object.entries(descriptors);
		if (
			Object.getOwnPropertySymbols(value).length ||
			entries.length > REALTIME_LIMITS.eventBytes ||
			(array && entries.length !== value.length + 1)
		)
			throw new RealtimeError("invalid-input");
		active.add(value);
		stack.push({ value, leave: true });
		for (const [key, descriptor] of entries) {
			if (array && key === "length") continue;
			if (
				(array &&
					(!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) ||
				!("value" in descriptor) ||
				!descriptor.enumerable
			)
				throw new RealtimeError("invalid-input");
			stack.push({ value: descriptor.value });
		}
	}
}
export type EventRegistry = Record<string, z.ZodType>;
export interface EncodedEvent {
	readonly type: string;
	readonly body: string;
	readonly bytes: number;
}
export function defineRealtimeEvents<const R extends EventRegistry>(
	registry: R,
): R {
	if (Object.keys(registry).some((t) => !/^[a-z][a-z0-9._-]{0,127}$/.test(t)))
		throw new RealtimeError("configuration");
	return Object.freeze({ ...registry });
}
export function encodeEvent<
	R extends EventRegistry,
	K extends keyof R & string,
>(registry: R, type: K, input: z.input<R[K]>): EncodedEvent {
	try {
		if (!Object.hasOwn(registry, type))
			throw new RealtimeError("invalid-input");
		const data = registry[type].parse(input);
		jsonSafe(data);
		const body = JSON.stringify({
			id: randomUUID(),
			type,
			occurredAt: new Date().toISOString(),
			data,
		});
		const bytes = Buffer.byteLength(body);
		if (bytes > REALTIME_LIMITS.eventBytes)
			throw new RealtimeError("invalid-input");
		return Object.freeze({ type, body, bytes });
	} catch {
		throw new RealtimeError("invalid-input");
	}
}
/** Process-local hints only: no history, replay or automatic subscription recovery. */
export function createRealtime<R extends EventRegistry>(registry: R) {
	const listeners = new Map<string, Set<(event: EncodedEvent) => void>>();
	const clients = new Set<() => void>();
	let closed = false;
	const assertOpen = () => {
		if (closed) throw new RealtimeError("closed");
	};
	return {
		registry,
		subscribe(
			channels: readonly string[],
			listener: (event: EncodedEvent) => void,
			close?: () => void,
		) {
			assertOpen();
			const names = authorizedChannels(channels);
			for (const name of names) {
				const set = listeners.get(name) ?? new Set();
				set.add(listener);
				listeners.set(name, set);
			}
			if (close) clients.add(close);
			let removed = false;
			return () => {
				if (removed) return;
				removed = true;
				for (const name of names) {
					const set = listeners.get(name);
					set?.delete(listener);
					if (!set?.size) listeners.delete(name);
				}
				if (close) clients.delete(close);
			};
		},
		dispatch(channel: string, event: EncodedEvent) {
			assertOpen();
			authorizedChannels([channel]);
			if (
				event.bytes !== Buffer.byteLength(event.body) ||
				event.bytes > REALTIME_LIMITS.eventBytes ||
				!Object.hasOwn(registry, event.type)
			)
				throw new RealtimeError("invalid-input");
			for (const listener of [...(listeners.get(channel) ?? [])]) {
				try {
					listener(event);
				} catch {
					/* Consumer failure cannot break fanout. */
				}
			}
		},
		publish<K extends keyof R & string>(
			channel: string,
			type: K,
			data: z.input<R[K]>,
		) {
			const event = encodeEvent(registry, type, data);
			this.dispatch(channel, event);
			return event;
		},
		get activeConnections() {
			return clients.size;
		},
		close() {
			if (closed) return;
			closed = true;
			for (const close of [...clients]) close();
			clients.clear();
			listeners.clear();
		},
	};
}
export type Realtime = ReturnType<typeof createRealtime<EventRegistry>>;

/** One explicitly accounted queue; byte-length strategy includes already-enqueued chunks. */
export function openSse(
	realtime: Realtime,
	channels: readonly string[],
	signal: AbortSignal,
) {
	authorizedChannels(channels);
	const encoder = new TextEncoder();
	let cleanup = () => {};
	let timer: ReturnType<typeof setInterval>;
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let closed = false;
				let closeCode: RealtimeCode = "closed";
				const close = () => {
					if (closed) return;
					closed = true;
					clearInterval(timer);
					unsubscribe();
					signal.removeEventListener("abort", close);
					try {
						controller.error(new RealtimeError(closeCode));
					} catch {}
				};
				const write = (value: string) => {
					if (closed) return;
					const chunk = encoder.encode(value);
					if ((controller.desiredSize ?? 0) < chunk.byteLength) {
						closeCode = "backpressure";
						close();
						return;
					}
					try {
						controller.enqueue(chunk);
					} catch {
						close();
					}
				};
				const unsubscribe = realtime.subscribe(
					channels,
					(event) => write(`event: ${event.type}\ndata: ${event.body}\n\n`),
					close,
				);
				cleanup = close;
				signal.addEventListener("abort", close, { once: true });
				timer = setInterval(
					() => write(": heartbeat\n\n"),
					REALTIME_LIMITS.heartbeatMs,
				);
				timer.unref?.();
				if (signal.aborted) close();
				else write(": connected\n\n");
			},
			cancel() {
				cleanup();
			},
		},
		{
			// Reserve two maximum wire chunks for the Node adapter's readable/writable buffers.
			// The complete connection budget remains 256KiB, not 256KiB per layer.
			highWaterMark:
				REALTIME_LIMITS.pendingBytes - 2 * (REALTIME_LIMITS.eventBytes + 256),
			size: (chunk) => chunk.byteLength,
		},
	);
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"X-Accel-Buffering": "no",
		},
	});
}

export interface SocketPeer {
	bufferedAmount: number;
	send(body: string): unknown;
	ping(data?: unknown): unknown;
	terminate(): void;
}
export function openSocket(
	realtime: Realtime,
	channels: readonly string[],
	peer: SocketPeer,
) {
	let alive = true,
		closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(timer);
		unsubscribe();
		try {
			peer.terminate();
		} catch {
			/* Already closed; never expose transport internals. */
		}
	};
	const unsubscribe = realtime.subscribe(
		channels,
		(event) => {
			// Reserve frame header overhead as well; never hand native WS an oversized buffer.
			if (
				peer.bufferedAmount + event.bytes + 16 >
				REALTIME_LIMITS.pendingBytes
			) {
				close();
				return;
			}
			try {
				peer.send(event.body);
			} catch {
				close();
			}
		},
		close,
	);
	const timer = setInterval(() => {
		if (!alive || peer.bufferedAmount > REALTIME_LIMITS.pendingBytes) {
			close();
			return;
		}
		alive = false;
		try {
			peer.ping("realtime-heartbeat");
		} catch {
			close();
		}
	}, REALTIME_LIMITS.heartbeatMs);
	timer.unref?.();
	return {
		close,
		pong() {
			alive = true;
		},
	};
}
