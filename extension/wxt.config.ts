import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";
import { DEFAULT_APP_NAME } from "./src/lib/app-name";
import { debuggerPermissionEnabled } from "./src/lib/build-flags";
import { STORE_HOST_PERMISSIONS } from "./src/lib/stores";

const appName = process.env.EXT_APP_NAME?.trim() || DEFAULT_APP_NAME;

/**
 * The `debugger` permission (PDF printing of HTML invoices) is OFF by default:
 * it triggers a scary install warning and grants broad power. Chrome does not
 * allow `debugger` in optional_permissions (it is silently dropped), so PDF
 * printing is a build-time opt-in: EXT_DEBUGGER_PERMISSION=required (or "on").
 * Without it, HTML invoices are uploaded as text/html invoice documents plus
 * an html_snapshot capture.
 */
const withDebugger = debuggerPermissionEnabled(process.env.EXT_DEBUGGER_PERMISSION);

// https://wxt.dev/api/config.html
export default defineConfig({
	srcDir: "src",
	modules: ["@wxt-dev/module-react"],
	imports: false,
	alias: {
		// The capture contract lives in the web app; import it, never copy it.
		"@app/shared": resolve(__dirname, "../src/shared"),
		// Make ../src/shared resolve `zod` from this package, not the root app.
		zod: resolve(__dirname, "node_modules/zod"),
	},
	vite: () => ({
		plugins: [tailwindcss()],
		resolve: { dedupe: ["zod", "react", "react-dom"] },
		build: { chunkSizeWarningLimit: 1500 },
	}),
	manifest: {
		name: appName,
		description: `${appName}: captures your own order pages and invoices and sends them to your self-hosted server.`,
		permissions: [
			"storage",
			"unlimitedStorage",
			"activeTab",
			"scripting",
			"alarms",
			"tabs",
			...(withDebugger ? (["debugger"] as const) : []),
		],
		host_permissions: STORE_HOST_PERMISSIONS,
		optional_host_permissions: ["https://*/*", "http://*/*"],
		action: { default_title: appName },
		minimum_chrome_version: "111",
	},
	hooks: {
		// WXT derives action.default_title from popup.html's <title>; use the product name.
		"build:manifestGenerated": (_wxt, manifest) => {
			manifest.action = { ...manifest.action, default_title: appName };
		},
	},
	zip: {
		artifactTemplate: "{{name}}-{{version}}-{{browser}}.zip",
	},
});
