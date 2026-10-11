import { z } from "zod";

export const apiPermissionsSchema = z.object({
	/** Browser extension: upload captures and documents. */
	captures: z.array(z.enum(["write"])).default([]),
	/** Browser extension: look up which store orders are tracked. */
	orders: z.array(z.enum(["read"])).default([]),
	/**
	 * Agent API: read (`read`) or change (`write`) orders, items, allocations,
	 * claims, captures, documents and exports.
	 */
	ledger: z.array(z.enum(["read", "write"])).default([]),
	/** Agent API: manage settings — entities, categories, payment methods, rules, connections. */
	admin: z.array(z.enum(["write"])).default([]),
});

export type ApiPermissions = z.infer<typeof apiPermissionsSchema>;
export type ApiPermissionRequirement = {
	[K in keyof ApiPermissions]?: ApiPermissions[K];
};

/** Grants needed by the browser extension. */
export const EXTENSION_PERMISSIONS = {
	captures: ["write"],
	orders: ["read"],
} as const;

/** Presets offered when creating an "Agent key" (coding agents, MCP clients). */
export const AGENT_PERMISSION_PRESETS = {
	readOnly: {
		label: "Read only",
		description: "List and inspect orders, claims, rules, captures, insights.",
		permissions: { ledger: ["read"] },
	},
	readWrite: {
		label: "Read & write",
		description:
			"Also create and triage orders, split items, reimbursements, claims, exports.",
		permissions: { ledger: ["read", "write"] },
	},
	admin: {
		label: "Admin",
		description:
			"Also manage entities, categories, payment methods, rules and connections.",
		permissions: { ledger: ["read", "write"], admin: ["write"] },
	},
} as const satisfies Record<
	string,
	{
		label: string;
		description: string;
		permissions: { [K in keyof ApiPermissions]?: readonly string[] };
	}
>;
export type AgentPreset = keyof typeof AGENT_PERMISSION_PRESETS;

/** Full permission object (every resource present) for a requirement-shaped grant. */
export function toApiPermissions(
	grant: {
		[K in keyof ApiPermissions]?: readonly ApiPermissions[K][number][];
	},
): ApiPermissions {
	return apiPermissionsSchema.parse(
		Object.fromEntries(
			Object.entries(grant).map(([resource, actions]) => [
				resource,
				[...(actions ?? [])],
			]),
		),
	);
}

/** Flat `resource:action` list, e.g. ["ledger:read", "admin:write"]. */
export function describePermissionGrants(
	permissions: Partial<Record<string, readonly string[] | undefined>>,
) {
	return Object.entries(permissions).flatMap(([resource, actions]) =>
		(actions ?? []).map((action) => `${resource}:${action}`),
	);
}

export function hasRequiredPermissions(
	actual: ApiPermissions,
	required: ApiPermissionRequirement,
) {
	return Object.entries(required).every(([resource, actions]) => {
		const granted: readonly string[] =
			actual[resource as keyof ApiPermissions] ?? [];
		return actions?.every((action) => granted.includes(action)) ?? true;
	});
}
