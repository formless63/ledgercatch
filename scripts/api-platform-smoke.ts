import assert from "node:assert/strict";
import { validate } from "@scalar/openapi-parser";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { apikey, user } from "#/db/schema";
import {
	extensionStatusApi,
	lookupOrdersApi,
} from "#/features/ledger/extension-api.server";
import { createOpenApiDocument } from "#/integrations/api-platform/openapi";
import { auth } from "#/lib/auth";

const userId = `api-smoke-${crypto.randomUUID()}`;
const lookupBody = JSON.stringify({
	source: "aliexpress",
	externalOrderIds: ["smoke-1"],
});

try {
	await db.insert(user).values({
		id: userId,
		name: "API Platform smoke",
		email: `${userId}@example.test`,
	});
	const captureKey = await auth.api.createApiKey({
		body: {
			userId,
			name: "smoke captures",
			permissions: { captures: ["write"] },
			rateLimitMax: 1_000,
			rateLimitTimeWindow: 60_000,
		},
	});
	const [stored] = await db
		.select({ key: apikey.key })
		.from(apikey)
		.where(eq(apikey.id, captureKey.id));
	assert.ok(stored?.key);
	assert.notEqual(stored.key, captureKey.key);
	assert.match(captureKey.key, /^app_/);
	assert.equal(captureKey.key.length, 68);
	assert.equal(captureKey.expiresAt, null);
	assert.equal(captureKey.rateLimitMax, 1_000);
	assert.equal(captureKey.rateLimitTimeWindow, 60_000);

	const statusResponse = await extensionStatusApi(
		new Request("http://localhost/api/v1/extension/status", {
			headers: { "x-api-key": captureKey.key },
		}),
	);
	assert.equal(statusResponse.status, 200);

	const lookupRequest = (key: string) =>
		new Request("http://localhost/api/v1/orders/lookup", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": key },
			body: lookupBody,
		});
	assert.equal((await lookupOrdersApi(lookupRequest(captureKey.key))).status, 403);

	const reader = await auth.api.createApiKey({
		body: {
			userId,
			name: "smoke orders",
			permissions: { orders: ["read"] },
			rateLimitMax: 1_000,
			rateLimitTimeWindow: 60_000,
		},
	});
	const lookupResponse = await lookupOrdersApi(lookupRequest(reader.key));
	assert.equal(lookupResponse.status, 200);
	assert.deepEqual(await lookupResponse.json(), { orders: [] });

	const openapi = createOpenApiDocument();
	const validation = await validate(JSON.stringify(openapi));
	assert.equal(validation.valid, true);
	assert.equal(openapi.openapi, "3.1.1");
	assert.ok(openapi.paths?.["/api/v1/captures"]);
	assert.ok(openapi.paths?.["/api/v1/orders/lookup"]);
	console.info("API Platform smoke passed");
} finally {
	await db.delete(apikey).where(eq(apikey.referenceId, userId));
	await db.delete(user).where(eq(user.id, userId));
}
