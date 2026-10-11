import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("optional Email telemetry omits all message/SMTP identifiers and content", () => {
	const result = spawnSync("bun", ["scripts/email-telemetry.ts"], {
		encoding: "utf8",
	});
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});
