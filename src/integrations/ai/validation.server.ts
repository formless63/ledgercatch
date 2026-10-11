import { AiError } from "./errors.server";
import type { AiFinishReason, AiInput, AiUsage } from "./types";
export const AI_MAX_OUTPUT_BYTES = 1024 * 1024;
const abortedGetter = Object.getOwnPropertyDescriptor(
	AbortSignal.prototype,
	"aborted",
)?.get;
function isAbortSignal(signal: unknown): signal is AbortSignal {
	try {
		// Invoke the intrinsic getter to check internal slots, not the prototype chain.
		if (!abortedGetter) return false;
		abortedGetter.call(signal);
		return signal instanceof AbortSignal;
	} catch {
		return false;
	}
}
export function validateAiInput(input: AiInput): AiInput {
	if (
		!input ||
		typeof input !== "object" ||
		Object.keys(input).some(
			(key) =>
				!["messages", "temperature", "maxOutputTokens", "signal"].includes(key),
		) ||
		!Array.isArray(input.messages) ||
		input.messages.length < 1 ||
		input.messages.length > 100
	)
		throw new AiError("invalid-request");
	let bytes = 0;
	for (const message of input.messages) {
		if (
			!message ||
			typeof message !== "object" ||
			Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
			!["system", "user", "assistant"].includes(message.role) ||
			typeof message.content !== "string" ||
			!message.content.trim() ||
			Buffer.from(message.content).toString() !== message.content ||
			Array.from(message.content).some((char) => {
				const code = char.charCodeAt(0);
				return (
					(code < 32 && ![9, 10, 13].includes(code)) ||
					(code >= 127 && code <= 159)
				);
			})
		)
			throw new AiError("invalid-request");
		const size = Buffer.byteLength(message.content);
		if (size > 64 * 1024) throw new AiError("invalid-request");
		bytes += size;
	}
	if (
		bytes > 256 * 1024 ||
		(input.temperature !== undefined &&
			(!Number.isFinite(input.temperature) ||
				input.temperature < 0 ||
				input.temperature > 2)) ||
		(input.maxOutputTokens !== undefined &&
			(!Number.isInteger(input.maxOutputTokens) ||
				input.maxOutputTokens < 1 ||
				input.maxOutputTokens > 65536)) ||
		(input.signal !== undefined && !isAbortSignal(input.signal))
	)
		throw new AiError("invalid-request");
	// Snapshot caller data before asynchronous work, preventing mutation after validation.
	return {
		...input,
		messages: input.messages.map((message) => ({ ...message })),
	};
}
export function finishReason(reason: unknown): AiFinishReason {
	return reason === "stop" || reason === "length"
		? reason
		: reason === "content_filter"
			? "content-filter"
			: "other";
}
export function usage(value: unknown): AiUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>,
		result: AiUsage = {};
	for (const [key, source] of [
		["inputTokens", "prompt_tokens"],
		["outputTokens", "completion_tokens"],
		["totalTokens", "total_tokens"],
	] as const) {
		const count = raw[source];
		if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
			result[key] = count;
	}
	return Object.keys(result).length ? result : undefined;
}
export function validateText(text: unknown): asserts text is string {
	if (
		typeof text !== "string" ||
		Buffer.from(text).toString() !== text ||
		Buffer.byteLength(text) > AI_MAX_OUTPUT_BYTES
	)
		throw new AiError("invalid-output");
}
