// Reference application only. Reusable AI has no telemetry dependency.
import type { z } from "zod";
import {
	type AiConfig,
	type AiInput,
	type AiStreamEvent,
	type AiUsage,
	createAi,
} from "../integrations/ai/ai.server";
import { getMeter } from "../integrations/observability/runtime.server";
export interface AiSignal {
	operation: "generate" | "stream" | "structured";
	provider: "openai-compatible";
	outcome: "success" | "error" | "cancelled";
	durationSeconds: number;
	finishReason?: "stop" | "length" | "content-filter" | "other";
	usage?: AiUsage;
}
export function observeAi(signal: AiSignal) {
	const attributes = {
		"app.ai.operation": signal.operation,
		"app.ai.provider": signal.provider,
		"app.ai.outcome": signal.outcome,
		...(signal.finishReason
			? { "app.ai.finish_reason": signal.finishReason }
			: {}),
	};
	const meter = getMeter();
	meter.createCounter("app.ai.operation.count").add(1, attributes);
	meter
		.createHistogram("app.ai.operation.duration", { unit: "s" })
		.record(signal.durationSeconds, attributes);
	for (const [key, count] of Object.entries(signal.usage ?? {}))
		if (Number.isSafeInteger(count) && count >= 0)
			meter.createCounter(`app.ai.tokens.${key}`).add(count, attributes);
}
export function createApplicationAi(
	config?: AiConfig,
	observe: (signal: AiSignal) => void | Promise<void> = observeAi,
) {
	const ai = createAi(config);
	const emit = (
		operation: AiSignal["operation"],
		started: number,
		outcome: AiSignal["outcome"],
		result?: Pick<AiSignal, "finishReason" | "usage">,
	) => {
		try {
			void Promise.resolve(
				observe({
					operation,
					provider: "openai-compatible",
					outcome,
					durationSeconds: (performance.now() - started) / 1000,
					...result,
				}),
			).catch(() => {
				/* Async telemetry failure is isolated without awaiting it. */
			});
		} catch {
			/* Telemetry never changes generation behavior. */
		}
	};
	async function run<T extends Pick<AiSignal, "finishReason" | "usage">>(
		operation: AiSignal["operation"],
		work: () => Promise<T>,
	) {
		const started = performance.now();
		try {
			const result = await work();
			emit(operation, started, "success", {
				finishReason: result.finishReason,
				usage: result.usage,
			});
			return result;
		} catch (error) {
			emit(operation, started, "error");
			throw error;
		}
	}
	return {
		generateText: (input: AiInput) =>
			run("generate", () => ai.generateText(input)),
		generateStructured: <T>(input: AiInput, schema: z.ZodType<T>) =>
			run("structured", () => ai.generateStructured(input, schema)),
		streamText(input: AiInput): AsyncIterableIterator<AiStreamEvent> {
			const stream = ai.streamText(input),
				started = performance.now();
			let terminal = false;
			const fail = () => {
				if (!terminal) {
					terminal = true;
					emit("stream", started, "error");
				}
			};
			return {
				async next() {
					try {
						const result = await stream.next();
						if (result.value?.type === "finish") {
							terminal = true;
							emit("stream", started, "success", {
								finishReason: result.value.finishReason,
								usage: result.value.usage,
							});
						}
						return result;
					} catch (error) {
						fail();
						throw error;
					}
				},
				async return() {
					if (!terminal) {
						terminal = true;
						emit("stream", started, "cancelled");
					}
					return stream.return
						? stream.return()
						: { done: true, value: undefined };
				},
				async throw(error?: unknown) {
					fail();
					if (stream.throw) return stream.throw(error);
					throw error;
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		},
	};
}
