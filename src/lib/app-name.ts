// Single client-side source for the display name; set VITE_APP_NAME to rename.
// Server-only code (Better Auth, email templates) uses `env.APP_NAME` from `#/env`.
// Optional chaining keeps this safe in plain Node/Bun scripts without Vite env.
export const appName: string =
	(import.meta.env?.VITE_APP_NAME as string | undefined)?.trim() ||
	(typeof process !== "undefined" ? process.env.APP_NAME?.trim() : undefined) ||
	"LedgerCatch";
