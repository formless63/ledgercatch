import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { alias: { "#": new URL("./src", import.meta.url).pathname, "@": new URL("./src", import.meta.url).pathname } }, test: { include: ["src/**/*.test.ts"], environment: "node", exclude: ["e2e/**", "extension/**", "node_modules/**", ".output/**"] } });
