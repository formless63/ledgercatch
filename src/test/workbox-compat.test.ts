import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getManifest } from "workbox-build";

it("discovers PWA assets through Workbox with the patched glob major", async () => {
	const root = await mkdtemp(join(tmpdir(), "pwa-glob-"));
	try {
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "assets/app.js"), "app");
		await writeFile(join(root, "assets/app.css"), "css");
		await writeFile(join(root, "assets/app.js.map"), "map");
		await writeFile(join(root, ".env"), "synthetic fixture");
		const result = await getManifest({
			globDirectory: root,
			globPatterns: ["**/*.{js,css}"],
			globIgnores: ["**/*.map"],
		});
		expect(result.warnings).toEqual([]);
		expect(result.count).toBe(2);
		expect(result.size).toBe(6);
		expect(result.manifestEntries.map((entry) => entry.url).sort()).toEqual([
			"assets/app.css",
			"assets/app.js",
		]);
		expect(
			result.manifestEntries.every(
				(entry) => typeof entry.revision === "string",
			),
		).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
