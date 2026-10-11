import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { auth } from "#/lib/auth";
import { requireUser } from "#/lib/session.server";
import { apiPermissionsSchema } from "./permissions";

export const createApiKeyInputSchema = z.object({
	name: z.string().trim().min(1, "Name is required").max(32),
	permissions: apiPermissionsSchema.refine(
		(value) => Object.values(value).some((actions) => actions.length > 0),
		"Choose at least one permission",
	),
	expiresInDays: z.number().int().min(1).max(365).nullable(),
});

export const apiKeyIdSchema = z.object({ keyId: z.string().min(1) });

type ApiKeyMetadata = {
	id: string;
	name: string | null;
	start: string | null;
	prefix: string | null;
	permissions: Record<string, string[]> | null;
	createdAt: string;
	expiresAt: string | null;
	enabled: boolean;
	lastRequest: string | null;
	rateLimitEnabled: boolean;
	rateLimitMax: number | null;
	rateLimitTimeWindow: number | null;
};

export function toSafeApiKeyMetadata(key: {
	id: string;
	name: string | null;
	start: string | null;
	prefix: string | null;
	permissions?: Record<string, string[]> | null;
	createdAt: Date;
	expiresAt: Date | null;
	enabled: boolean;
	lastRequest: Date | null;
	rateLimitEnabled: boolean;
	rateLimitMax: number | null;
	rateLimitTimeWindow: number | null;
}): ApiKeyMetadata {
	return {
		id: key.id,
		name: key.name,
		start: key.start,
		prefix: key.prefix,
		permissions: key.permissions ?? null,
		createdAt: key.createdAt.toISOString(),
		expiresAt: key.expiresAt?.toISOString() ?? null,
		enabled: key.enabled,
		lastRequest: key.lastRequest?.toISOString() ?? null,
		rateLimitEnabled: key.rateLimitEnabled,
		rateLimitMax: key.rateLimitMax,
		rateLimitTimeWindow: key.rateLimitTimeWindow,
	};
}

export async function createManagedApiKey(
	input: z.infer<typeof createApiKeyInputSchema>,
) {
	const parsed = createApiKeyInputSchema.parse(input);
	const user = await requireUser();
	const created = await auth.api.createApiKey({
		body: {
			userId: user.id,
			name: parsed.name,
			permissions: parsed.permissions,
			expiresIn: parsed.expiresInDays
				? parsed.expiresInDays * 24 * 60 * 60
				: null,
			rateLimitEnabled: true,
			rateLimitMax: 1_000,
			rateLimitTimeWindow: 60 * 1000,
		},
	});
	return { secret: created.key, apiKey: toSafeApiKeyMetadata(created) };
}

export async function listManagedApiKeys() {
	await requireUser();
	const result = await auth.api.listApiKeys({
		headers: getRequestHeaders(),
		query: { sortBy: "createdAt", sortDirection: "desc" },
	});
	return result.apiKeys.map(toSafeApiKeyMetadata);
}

export async function revokeManagedApiKey(input: { keyId: string }) {
	const { keyId } = apiKeyIdSchema.parse(input);
	await requireUser();
	const updated = await auth.api.updateApiKey({
		headers: getRequestHeaders(),
		body: { keyId, enabled: false },
	});
	return toSafeApiKeyMetadata(updated);
}
