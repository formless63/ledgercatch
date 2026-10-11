import type { z } from "zod";
import {
	type AiConfig,
	resolveAiConfig,
	validateAiConfig,
} from "./config.server";
import { AiError, aiError } from "./errors.server";
import { createProvider } from "./provider.server";
import type { AiInput, AiStreamEvent, AiTextResult } from "./types";
import {
	AI_MAX_OUTPUT_BYTES,
	finishReason,
	usage,
	validateAiInput,
	validateText,
} from "./validation.server";

export type { AiConfig } from "./config.server";
export { resolveAiConfig, validateAiConfig } from "./config.server";
export { AiError } from "./errors.server";
export type {
	AiFinishReason,
	AiInput,
	AiStreamEvent,
	AiTextResult,
	AiUsage,
} from "./types";

function deadline(
	seconds: number,
	caller?: AbortSignal,
	consumer?: AbortSignal,
) {
	const controller = new AbortController();
	const expiresAt = performance.now() + seconds * 1000;
	let reason: "timeout" | "cancelled" | undefined;
	const abort = (code: "timeout" | "cancelled") => {
		if (!reason) {
			reason = code;
			controller.abort();
		}
	};
	const cancel = () => abort("cancelled");
	const signals = [caller, consumer].filter(
		(signal): signal is AbortSignal => !!signal,
	);
	for (const signal of signals) {
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
	}
	const timer = setTimeout(() => abort("timeout"), seconds * 1000);
	return {
		signal: controller.signal,
		async wait<T>(work: Promise<T>): Promise<T> {
			let onAbort!: () => void;
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(new AiError(reason ?? "cancelled"));
				if (controller.signal.aborted) onAbort();
				else
					controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			try {
				// Racing observes late rejection too; user validation cannot be forcibly stopped.
				return await Promise.race([work, aborted]);
			} finally {
				controller.signal.removeEventListener("abort", onAbort);
			}
		},
		check() {
			if (!reason && performance.now() >= expiresAt) abort("timeout");
			if (reason) throw new AiError(reason);
		},
		error(error: unknown) {
			return reason ? new AiError(reason) : aiError(error);
		},
		close() {
			clearTimeout(timer);
			for (const signal of signals) signal.removeEventListener("abort", cancel);
			controller.abort();
		},
	};
}
export function createAi(config?: AiConfig) {
	// Nothing validates, constructs an SDK client, or contacts a provider until use.
	const ready = () => {
		try {
			const resolved = config ? validateAiConfig(config) : resolveAiConfig();
			return { config: resolved, provider: createProvider(resolved) };
		} catch {
			throw new AiError("configuration");
		}
	};
	async function complete<T>(
		input: AiInput,
		structured: boolean,
		output: (result: AiTextResult) => Promise<T>,
	): Promise<T> {
		const validated = validateAiInput(input),
			{ config, provider } = ready();
		const scope = deadline(config.timeoutSeconds, validated.signal);
		try {
			scope.check();
			const response = await provider.complete(
				validated,
				structured,
				scope.signal,
			);
			scope.check();
			const choice = response.choices?.[0];
			if (
				!choice ||
				typeof choice.finish_reason !== "string" ||
				!choice.finish_reason ||
				(structured && choice.finish_reason !== "stop") ||
				choice.message?.refusal ||
				choice.message?.tool_calls?.length
			)
				throw new AiError("invalid-output");
			const text = choice.message?.content;
			validateText(text);
			const result: AiTextResult = {
				text,
				finishReason: finishReason(choice.finish_reason),
				...(usage(response.usage) ? { usage: usage(response.usage) } : {}),
			};
			const validatedOutput = await scope.wait(output(result));
			scope.check();
			return validatedOutput;
		} catch (error) {
			throw scope.error(error);
		} finally {
			scope.close();
		}
	}
	return {
		generateText: (input: AiInput) =>
			complete(input, false, async (result) => result),
		async generateStructured<T>(
			input: AiInput,
			schema: z.ZodType<T>,
		): Promise<{
			object: T;
			finishReason: AiTextResult["finishReason"];
			usage?: AiTextResult["usage"];
		}> {
			return complete(input, true, async (result) => {
				try {
					const parsed = await schema.safeParseAsync(JSON.parse(result.text));
					if (!parsed.success) throw new AiError("invalid-output");
					return {
						object: parsed.data,
						finishReason: result.finishReason,
						...(result.usage ? { usage: result.usage } : {}),
					};
				} catch {
					throw new AiError("invalid-output");
				}
			});
		},
		streamText(input: AiInput): AsyncIterableIterator<AiStreamEvent> {
			const consumer = new AbortController();
			async function* events(): AsyncGenerator<AiStreamEvent> {
				const validated = validateAiInput(input),
					{ config, provider } = ready();
				const scope = deadline(
					config.timeoutSeconds,
					validated.signal,
					consumer.signal,
				);
				let stream: Awaited<ReturnType<typeof provider.stream>> | undefined;
				try {
					scope.check();
					stream = await provider.stream(validated, scope.signal);
					let bytes = 0,
						trailingHigh = false,
						terminal = false;
					let reason: AiTextResult["finishReason"] = "other",
						tokens: AiTextResult["usage"];
					for await (const chunk of stream) {
						scope.check();
						if (chunk.usage) tokens = usage(chunk.usage);
						if (!Array.isArray(chunk.choices))
							throw new AiError("invalid-output");
						const choice = chunk.choices[0];
						if (!choice) continue; // Usage-only chunk.
						if (choice.delta?.refusal || choice.delta?.tool_calls?.length)
							throw new AiError("invalid-output");
						const text = choice.delta?.content;
						if (text !== undefined && text !== null) {
							if (typeof text !== "string" || terminal)
								throw new AiError("invalid-output");
							// Reject malformed UTF-16, allowing a pair split between deltas.
							const joined = (trailingHigh ? "\ud800" : "") + text;
							const whole = /[\ud800-\udbff]$/.test(joined)
								? joined.slice(0, -1)
								: joined;
							if (Buffer.from(whole).toString() !== whole)
								throw new AiError("invalid-output");
							// Account UTF-8 correctly when a surrogate pair is split between deltas.
							bytes += Buffer.byteLength(text);
							if (trailingHigh && /^[\udc00-\udfff]/.test(text)) bytes -= 2;
							if (text.length) trailingHigh = /[\ud800-\udbff]$/.test(text);
							if (bytes > AI_MAX_OUTPUT_BYTES)
								throw new AiError("invalid-output");
							if (text) yield { type: "text-delta", text };
						}
						if (
							choice.finish_reason !== null &&
							choice.finish_reason !== undefined
						) {
							if (terminal) throw new AiError("invalid-output");
							terminal = true;
							reason = finishReason(choice.finish_reason);
						}
					}
					scope.check();
					if (!terminal || trailingHigh) throw new AiError("invalid-output");
					stream.controller.abort();
					scope.close();
					yield {
						type: "finish",
						finishReason: reason,
						...(tokens ? { usage: tokens } : {}),
					};
				} catch (error) {
					throw scope.error(error);
				} finally {
					stream?.controller.abort();
					scope.close();
				}
			}
			const iterator = events();
			// return/throw must abort immediately even when next() is waiting on a stalled socket.
			return {
				next: () => iterator.next(),
				async return() {
					consumer.abort();
					return iterator.return(undefined);
				},
				async throw(error?: unknown) {
					consumer.abort();
					return iterator.throw(error);
				},
				[Symbol.asyncIterator]() {
					return this;
				},
			};
		},
	};
}
export const generateText = (input: AiInput) => createAi().generateText(input);
export const streamText = (input: AiInput) => createAi().streamText(input);
export const generateStructured = <T>(input: AiInput, schema: z.ZodType<T>) =>
	createAi().generateStructured(input, schema);
