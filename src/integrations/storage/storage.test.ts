import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("storage configuration, keys, metadata, signatures and safe errors", () => {
	const result = spawnSync("bun", ["scripts/storage-unit.ts"], {
		encoding: "utf8",
	});
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});
test("optional application telemetry omits identifiers and temporary credentials", () => {
	const result = spawnSync("bun", ["scripts/storage-telemetry.ts"], {
		encoding: "utf8",
	});
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});
