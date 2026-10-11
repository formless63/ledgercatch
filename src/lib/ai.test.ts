import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { type AiSignal, createApplicationAi } from "./ai.server";

it("keeps application instrumentation optional and lazy", async () => {
	const ai = createApplicationAi(
		{ provider: "openai-compatible", model: "", timeoutSeconds: 60 },
		() => {
			throw new Error("telemetry failure");
		},
	);
	await expect(
		ai.generateText({ messages: [{ role: "user", content: "x" }] }),
	).rejects.toMatchObject({ code: "configuration" });
});

it("preserves real HTTP operations when application telemetry throws", async () => {
	const { runAiFixture } = await import("../../scripts/ai-fixture");
	const signals: unknown[] = [];
	await runAiFixture((config) =>
		createApplicationAi(config, (signal) => {
			signals.push(signal);
			throw new Error("telemetry failure");
		}),
	);
	expect(signals.length).toBeGreaterThan(0);
	expect(JSON.stringify(signals)).not.toMatch(
		/fixture-model|fixture-api-key|hello|answer|messages|baseUrl/,
	);
}, 15000);

it("isolates rejecting async observers across success, failure and cancellation", async () => {
	const { runAiFixture } = await import("../../scripts/ai-fixture");
	const signals: AiSignal[] = [];
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	process.on("unhandledRejection", onUnhandled);
	try {
		await runAiFixture((config) =>
			createApplicationAi(config, async (signal) => {
				signals.push(signal);
				await setImmediate();
				throw new Error("async telemetry failure");
			}),
		);
		await setImmediate();
		await setImmediate();
		expect(unhandled).toEqual([]);
		for (const operation of ["generate", "structured", "stream"])
			for (const outcome of ["success", "error"])
				expect(signals).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ operation, outcome }),
					]),
				);
		expect(signals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ operation: "stream", outcome: "cancelled" }),
			]),
		);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}, 15000);

it("does not await observer latency on successful, failed or cancelled operations", async () => {
	const { runAiFixture } = await import("../../scripts/ai-fixture");
	await runAiFixture((config) =>
		createApplicationAi(config, () => new Promise<void>(() => {})),
	);
}, 15000);
