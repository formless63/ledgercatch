// This is the sole SDK boundary. Applications consume ai.server.ts only.
import OpenAI from "openai";
import type { AiConfig } from "./config.server";
import { AiError } from "./errors.server";
import type { AiInput } from "./types";

// Bound transport envelopes too, before SDK JSON/SSE parsing. Text has its own 1 MiB bound.
const MAX_TRANSPORT_BYTES = 32 * 1024 * 1024;
export function createProvider(config: AiConfig) {
	// A provider is operation-local; retain only the finite transport failure,
	// because the SDK can discard body-read errors when constructing an API error.
	let oversizedTransport = false;
	const preserveTransportFailure = async <T>(
		work: PromiseLike<T>,
	): Promise<T> => {
		try {
			return await work;
		} catch (error) {
			if (oversizedTransport) throw new AiError("invalid-output");
			throw error;
		}
	};
	const client = new OpenAI({
		apiKey: config.apiKey || "local-no-auth",
		baseURL: config.baseUrl ?? "https://api.openai.com/v1",
		adminAPIKey: null,
		organization: null,
		project: null,
		defaultHeaders: config.apiKey ? {} : { Authorization: null },
		maxRetries: 0,
		timeout: config.timeoutSeconds * 1000 + 1000,
		logLevel: "off",
		fetch: async (url, options) => {
			// Canonical AI config is the only source of auth and outbound headers;
			// ignore SDK-specific OPENAI_* environment/header inheritance.
			const headers = new Headers({ "Content-Type": "application/json" });
			if (config.apiKey)
				headers.set("Authorization", `Bearer ${config.apiKey}`);
			const response = await fetch(url, {
				...options,
				headers,
				redirect: "error",
			});
			if (!response.body) return response;
			let bytes = 0;
			const body = response.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						bytes += chunk.byteLength;
						if (bytes > MAX_TRANSPORT_BYTES) {
							oversizedTransport = true;
							throw new AiError("invalid-output");
						}
						controller.enqueue(chunk);
					},
				}),
			);
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		},
	});
	const request = (input: AiInput, structured: boolean) => ({
		model: config.model,
		messages: input.messages,
		...(input.temperature !== undefined
			? { temperature: input.temperature }
			: {}),
		...(input.maxOutputTokens !== undefined
			? { max_tokens: input.maxOutputTokens }
			: {}),
		...(structured
			? { response_format: { type: "json_object" as const } }
			: {}),
	});
	return {
		complete: (input: AiInput, structured: boolean, signal: AbortSignal) =>
			preserveTransportFailure(
				client.chat.completions.create(
					{ ...request(input, structured), stream: false },
					{ signal },
				),
			),
		stream: (input: AiInput, signal: AbortSignal) =>
			preserveTransportFailure(
				client.chat.completions.create(
					{
						...request(input, false),
						stream: true,
						stream_options: { include_usage: true },
					},
					{ signal },
				),
			),
	};
}
