/**
 * Render assets/icon.svg to public/icon/{16,32,48,128}.png (picked up by WXT
 * for the manifest icons). Run with `bun run icons` after editing the SVG.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "assets/icon.svg"), "utf8");
const outDir = join(root, "public/icon");
mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
	const png = new Resvg(svg, { fitTo: { mode: "width", value: size }, shapeRendering: 2 }).render().asPng();
	writeFileSync(join(outDir, `${size}.png`), png);
	console.log(`icon/${size}.png (${png.byteLength} bytes)`);
}
