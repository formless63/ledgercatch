import { defineConfig } from "nitro/config";
import { publicAssets, pwaConfig } from "./src/integrations/pwa-offline/config";

export default defineConfig({
	features: { websocket: true },
	serverDir: "./server",
	// PWA / Offline: cache headers for the fixed, capability-owned public files only.
	routeRules: Object.fromEntries(
		publicAssets.map((asset) => [
			`${pwaConfig.base}${asset}`,
			{
				headers: {
					"cache-control": asset.endsWith(".html")
						? "public, max-age=300"
						: "public, max-age=31536000, immutable",
				},
			},
		]),
	),
});
