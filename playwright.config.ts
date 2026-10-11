import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.e2e.ts",
	use: { baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3000" },
	webServer: process.env.E2E_BASE_URL ? undefined : {
		command: "bun run dev",
		env: { REALTIME_TRANSPORTS: "sse,websocket" },
		url: "http://127.0.0.1:3000",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
