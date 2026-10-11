import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("proves safe structured signals and real optional OTLP export in an isolated runtime", async () => {
	const { stdout } = await promisify(execFile)(
		"bun",
		["scripts/observability-smoke.ts"],
		{ timeout: 30_000 },
	);
	expect(stdout).toContain("Observability smoke passed");
}, 35_000);
