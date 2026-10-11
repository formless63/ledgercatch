import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createAi } from "./ai.server";
import { resolveAiConfig, validateAiConfig } from "./config.server";
import { AiError, aiError } from "./errors.server";
import { finishReason, usage, validateAiInput } from "./validation.server";

const input = { messages: [{ role: "user" as const, content: "hello" }] };
describe("AI v1 backendless contract", () => {
	it("rejects forged signal brands safely before network", async () => {
		const signal = Object.create(AbortSignal.prototype);
		expect(() => validateAiInput({ ...input, signal })).toThrow(AiError);
		await expect(
			createAi().generateText({ ...input, signal }),
		).rejects.toMatchObject({ code: "invalid-request" });
	});
	it("limits HTTP to literal original loopback authorities", () => {
		for (const host of [
			"127.1",
			"2130706433",
			"0x7f000001",
			"0177.0.0.1",
			"127.000.000.001",
		]) {
			expect(() =>
				resolveAiConfig({
					AI_MODEL: "x",
					AI_BASE_URL: `http://${host}/v1`,
					NODE_ENV: "test",
				}),
			).toThrow(AiError);
			expect(
				resolveAiConfig({
					AI_MODEL: "x",
					AI_BASE_URL: `https://${host}/v1`,
					NODE_ENV: "production",
				}).baseUrl,
			).toBe(`https://${host}/v1`);
		}
		for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
			expect(
				resolveAiConfig({
					AI_MODEL: "x",
					AI_BASE_URL: `http://${host}:1234/v1`,
					NODE_ENV: "test",
				}).baseUrl,
			).toBe(`http://${host}:1234/v1`);
		}
	});

	it("is lazy and has canonical configuration defaults", async () => {
		createAi();
		expect(resolveAiConfig({ AI_MODEL: "explicit-model" })).toEqual({
			provider: "openai-compatible",
			model: "explicit-model",
			timeoutSeconds: 60,
		});
		await expect(
			createAi({
				provider: "openai-compatible",
				model: "",
				timeoutSeconds: 60,
			}).generateText(input),
		).rejects.toMatchObject({ code: "configuration" });
		for (const env of [
			{},
			{ AI_MODEL: "x", AI_PROVIDER: "other" },
			{ AI_MODEL: "x", AI_TIMEOUT_SECONDS: "0" },
			{ AI_MODEL: "x", AI_TIMEOUT_SECONDS: "301" },
			{ AI_MODEL: "x", AI_TIMEOUT_SECONDS: "1.5" },
			{ AI_MODEL: "x", AI_TIMEOUT_SECONDS: "" },
			{ AI_MODEL: "x".repeat(129) },
			{ AI_MODEL: "x\n" },
			{ AI_MODEL: "x", AI_BASE_URL: "http://example.com/v1" },
			{
				AI_MODEL: "x",
				AI_BASE_URL: "http://localhost/v1",
				NODE_ENV: "production",
			},
			{ AI_MODEL: "x", AI_BASE_URL: "https://user:secret@example.com" },
			{ AI_MODEL: "x", AI_BASE_URL: "https://example.com?key=secret" },
		])
			expect(() => resolveAiConfig(env)).toThrow(AiError);
		for (const timeoutSeconds of [1, 300])
			expect(
				validateAiConfig({
					provider: "openai-compatible",
					model: "x",
					timeoutSeconds,
				}).timeoutSeconds,
			).toBe(timeoutSeconds);
		expect(
			resolveAiConfig({
				AI_MODEL: "x",
				AI_BASE_URL: "http://localhost/v1",
				NODE_ENV: "development",
			}).baseUrl,
		).toBe("http://localhost/v1");
	});
	it("bounds UTF-8 inputs, rejects malformed/control/extra input and snapshots", () => {
		for (const messages of [
			[],
			Array.from({ length: 101 }, () => input.messages[0]),
			[{ role: "tool", content: "x" }],
			[{ role: "user", content: "" }],
			[{ role: "user", content: "\u0000" }],
			[{ role: "user", content: "\ud800" }],
			[{ role: "user", content: "é".repeat(32769) }],
			Array.from({ length: 5 }, () => ({
				role: "user",
				content: "x".repeat(65536),
			})),
			[{ role: "user", content: "x", extra: "x" }],
		])
			expect(() => validateAiInput({ messages } as typeof input)).toThrow(
				AiError,
			);
		for (const controls of [
			{ temperature: NaN },
			{ temperature: -1 },
			{ temperature: 2.1 },
			{ maxOutputTokens: 0 },
			{ maxOutputTokens: 65537 },
			{ maxOutputTokens: 1.5 },
			{ tools: [] },
			{ signal: {} as AbortSignal },
		])
			expect(() => validateAiInput({ ...input, ...controls })).toThrow(AiError);
		expect(
			validateAiInput({
				messages: Array.from({ length: 4 }, () => ({
					role: "user",
					content: "é".repeat(32768),
				})),
				temperature: 2,
				maxOutputTokens: 65536,
			}),
		).toBeDefined();
		expect(
			validateAiInput({ ...input, temperature: 0, maxOutputTokens: 1 })
				.messages,
		).not.toBe(input.messages);
	});
	it("validates Unicode model IDs and header-safe keys in both config paths", async () => {
		const base = {
			provider: "openai-compatible" as const,
			model: "visible",
			timeoutSeconds: 60,
		};
		for (const model of [
			"visible / 模型 🚀",
			"private-\ue000",
			"🚀".repeat(128),
		]) {
			expect(validateAiConfig({ ...base, model }).model).toBe(model);
			expect(resolveAiConfig({ AI_MODEL: model }).model).toBe(model);
		}
		for (const apiKey of [
			"",
			"local-éÿ",
			"\u00a0key\u00a0",
			"x".repeat(256 * 1024),
		]) {
			expect(validateAiConfig({ ...base, apiKey }).apiKey).toBe(apiKey);
			expect(
				resolveAiConfig({ AI_MODEL: base.model, AI_API_KEY: apiKey }).apiKey,
			).toBe(apiKey);
		}
		for (const model of [
			" ",
			"\ud800",
			"🚀".repeat(129),
			"private-model\u0001",
			"private-model\u0085",
			"private-model\u200d",
			"private-model\ufeff",
			"private-model\u2028",
			"private-model\u2029",
		])
			for (const read of [
				() => validateAiConfig({ ...base, model }),
				() => resolveAiConfig({ AI_MODEL: model }),
			]) {
				expect(read).toThrow(AiError);
				try {
					read();
				} catch (error) {
					expect(JSON.stringify(error) + inspect(error)).not.toMatch(
						/private-key|private-model/,
					);
				}
				await expect(
					createAi({ ...base, model }).generateText(input),
				).rejects.toMatchObject({ code: "configuration" });
			}
		for (const apiKey of [
			" private-key",
			"private-key ",
			"private-key\ud800",
			"private-key\u0100",
			"private-key🚀",
			"private-key\n",
			"private-key\u007f",
			"private-key\u0080",
			"private-key\u009f",
		])
			for (const read of [
				() => validateAiConfig({ ...base, apiKey }),
				() => resolveAiConfig({ AI_MODEL: base.model, AI_API_KEY: apiKey }),
			]) {
				expect(read).toThrow(AiError);
				try {
					read();
				} catch (error) {
					expect(JSON.stringify(error) + inspect(error)).not.toMatch(
						/private-key|private-model/,
					);
				}
				await expect(
					createAi({ ...base, apiKey }).generateText(input),
				).rejects.toMatchObject({ code: "configuration" });
			}
	});
	it("normalizes finite usage and safe errors without any provider cause", () => {
		expect(
			usage({
				prompt_tokens: -1,
				completion_tokens: Infinity,
				total_tokens: 1.5,
			}),
		).toBeUndefined();
		expect(usage({ prompt_tokens: 0 })).toEqual({ inputTokens: 0 });
		expect(
			["stop", "length", "content_filter", "tool_calls"].map(finishReason),
		).toEqual(["stop", "length", "content-filter", "other"]);
		for (const error of [
			{ status: 401, body: "secret" },
			{ status: 429, message: "prompt" },
			new Error("private-output"),
		]) {
			const safe = aiError(error);
			expect(safe.cause).toBeUndefined();
			expect(JSON.stringify(safe) + inspect(safe)).not.toMatch(
				/secret|prompt|private-output/,
			);
		}
		expect(new AiError("timeout").retryable).toBe(false);
		expect(aiError(new SyntaxError("private-output")).code).toBe(
			"invalid-output",
		);
	});
});

it("exercises the real SDK against local HTTP including stalled sockets", async () => {
	const { runAiFixture } = await import("../../../scripts/ai-fixture");
	await runAiFixture();
}, 15000);
