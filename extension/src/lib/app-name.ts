/**
 * Build-time default product name. The real name is injected via the
 * `EXT_APP_NAME` environment variable when building and lands in the manifest;
 * UI code reads it back with `appName()` (see ./app.ts). Do not hardcode the
 * product name anywhere else.
 */
export const DEFAULT_APP_NAME = "LedgerCatch";
