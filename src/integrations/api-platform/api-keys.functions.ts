import { createServerFn } from "@tanstack/react-start";
import { apiKeyIdSchema, createApiKeyInputSchema } from "./api-keys.server";

export const createApiKey = createServerFn({ method: "POST" })
	.validator(createApiKeyInputSchema)
	.handler(async ({ data }) =>
		(await import("./api-keys.server")).createManagedApiKey(data),
	);

export const listApiKeys = createServerFn({ method: "GET" }).handler(async () =>
	(await import("./api-keys.server")).listManagedApiKeys(),
);

export const getApiKeyManager = createServerFn({ method: "GET" }).handler(
	async () => (await import("#/lib/session.server")).currentUser(),
);

export const revokeApiKey = createServerFn({ method: "POST" })
	.validator(apiKeyIdSchema)
	.handler(async ({ data }) =>
		(await import("./api-keys.server")).revokeManagedApiKey(data),
	);
