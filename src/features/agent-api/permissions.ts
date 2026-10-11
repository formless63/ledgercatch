/** Permission requirements used by the agent API (REST v1 and MCP tools). */
import type { ApiPermissionRequirement } from "#/integrations/api-platform/permissions";

export type PermissionLevel = "any" | "read" | "write" | "admin";

export const PERMISSIONS: Record<PermissionLevel, ApiPermissionRequirement> = {
	/** Any valid key. */
	any: {},
	read: { ledger: ["read"] },
	write: { ledger: ["write"] },
	admin: { admin: ["write"] },
};

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
	any: "any valid key",
	read: "ledger:read",
	write: "ledger:write",
	admin: "admin:write",
};
