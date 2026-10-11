import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("the reusable Search contract runs on real PostgreSQL 18", () => {
	const result = spawnSync("bun", ["scripts/search-smoke.ts"], {
		encoding: "utf8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	expect(result.stdout).toContain("Search PostgreSQL 18 safety");
}, 30000);
