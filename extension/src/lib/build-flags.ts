/**
 * Build-time flags read by wxt.config.ts (pure, so they are unit-tested).
 *
 * EXT_DEBUGGER_PERMISSION: the `debugger` permission is OFF unless the value
 * is "required", "on", "true" or "1". Anything else (including unset and the
 * legacy "off") builds without it.
 */
export function debuggerPermissionEnabled(raw: string | undefined): boolean {
	const value = (raw ?? "off").trim().toLowerCase();
	return value === "required" || value === "on" || value === "true" || value === "1";
}
