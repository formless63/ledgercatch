import assert from "node:assert/strict";
import { resolveAiConfig } from "../src/integrations/ai/config.server";
import { validateAiInput, validateText } from "../src/integrations/ai/validation.server";
assert.equal(resolveAiConfig({ AI_MODEL: "fixture" }).timeoutSeconds, 60);
assert.throws(() => resolveAiConfig({}));
assert.throws(() => validateAiInput({ messages: [] }));
assert.throws(() => validateText("x".repeat(1048577)));
console.info("AI backendless checks passed");
