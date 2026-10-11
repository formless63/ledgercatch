import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["e2e/command-system.dom.tsx"],
	},
});
