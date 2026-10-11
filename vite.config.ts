import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { pwaOffline } from "./scripts/pwa-vite";
import { clientDisconnect } from "./scripts/vite-client-disconnect";

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	environments: {
		client: {
			// Keep the client dependency set stable while the first page hydrates.
			optimizeDeps: {
				noDiscovery: true,
				include: [
					"@tanstack/react-hotkeys",
					"recharts",
					"use-sync-external-store/shim",
					"use-sync-external-store/shim/with-selector",
					"better-auth/react",
					"better-auth/client/plugins",
					"@scalar/api-reference-react",
					"@tabler/icons-react",
					"@tanstack/react-devtools",
					"@tanstack/react-form",
					"@tanstack/react-query",
					"@tanstack/react-query-devtools",
					"@tanstack/react-router-ssr-query",
					"sonner",
					"zod",
				],
			},
		},
	},
	plugins: [
		nitro(),
		...pwaOffline(),
		devtools(),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		clientDisconnect(),
	],
});

export default config;
