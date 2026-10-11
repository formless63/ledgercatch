import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "#/db";
import { apikey, orders, user } from "#/db/schema";
import {
	extensionStatusApi,
	lookupOrdersApi,
} from "#/features/ledger/extension-api.server";
import { auth } from "#/lib/auth";
import { toSafeApiKeyMetadata } from "./api-keys.server";
import type { ApiPermissionRequirement } from "./permissions";

const userAId = `api-user-a-${crypto.randomUUID()}`;
const userBId = `api-user-b-${crypto.randomUUID()}`;
const userAOrderId = crypto.randomUUID();
const userBOrderId = crypto.randomUUID();
const lookupUrl = "http://localhost/api/v1/orders/lookup";
const statusUrl = "http://localhost/api/v1/extension/status";

async function createKey(
	name: string,
	permissions: ApiPermissionRequirement,
	rateLimitMax = 1_000,
) {
	return auth.api.createApiKey({
		body: {
			userId: userAId,
			name,
			permissions,
			rateLimitEnabled: true,
			rateLimitMax,
			rateLimitTimeWindow: 60_000,
		},
	});
}

function apiRequest(
	url: string,
	method: "GET" | "POST",
	key?: string,
	body?: unknown,
) {
	return new Request(url, {
		method,
		headers: {
			...(key ? { "x-api-key": key } : {}),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const lookup = (key: string | undefined, body: unknown) =>
	lookupOrdersApi(apiRequest(lookupUrl, "POST", key, body));
const sharedLookup = {
	source: "aliexpress",
	externalOrderIds: ["A-100", "B-200"],
};

describe("API Platform machine authentication and extension routes", () => {
	beforeAll(async () => {
		await db.insert(user).values([
			{ id: userAId, name: "API User A", email: `${userAId}@example.test` },
			{ id: userBId, name: "API User B", email: `${userBId}@example.test` },
		]);
		await db.insert(orders).values([
			{
				id: userAOrderId,
				ownerId: userAId,
				source: "aliexpress",
				externalOrderId: "A-100",
			},
			{
				id: userBOrderId,
				ownerId: userBId,
				source: "aliexpress",
				externalOrderId: "B-200",
			},
		]);
	});

	afterAll(async () => {
		await db.delete(apikey).where(eq(apikey.referenceId, userAId));
		await db.delete(user).where(eq(user.id, userAId));
		await db.delete(user).where(eq(user.id, userBId));
	});

	it("hashes a newly created key and exposes its secret only in the creation result", async () => {
		const created = await createKey("hash proof", { orders: ["read"] });
		const [stored] = await db
			.select()
			.from(apikey)
			.where(eq(apikey.id, created.id));

		expect(created.key).toMatch(/^app_/);
		expect(created.key).toHaveLength(68);
		expect(created.rateLimitMax).toBe(1_000);
		expect(created.rateLimitTimeWindow).toBe(60_000);
		expect(created.expiresAt).toBeNull();
		expect(stored?.key).toBeTruthy();
		expect(stored?.key).not.toBe(created.key);
		expect(stored?.key).not.toContain(created.key);
		expect(toSafeApiKeyMetadata(created)).not.toHaveProperty("key");
	});

	it("returns 401 for missing, random, query-string, disabled, and expired credentials", async () => {
		await expect(
			extensionStatusApi(apiRequest(statusUrl, "GET")),
		).resolves.toMatchObject({ status: 401 });
		await expect(
			extensionStatusApi(
				apiRequest(statusUrl, "GET", "app_random-invalid-key"),
			),
		).resolves.toMatchObject({ status: 401 });
		const queryCredential = await createKey("query rejected", {
			orders: ["read"],
		});
		await expect(
			extensionStatusApi(
				new Request(
					`${statusUrl}?apiKey=${encodeURIComponent(queryCredential.key)}`,
				),
			),
		).resolves.toMatchObject({ status: 401 });

		const disabled = await createKey("disabled", { orders: ["read"] });
		await db
			.update(apikey)
			.set({ enabled: false })
			.where(eq(apikey.id, disabled.id));
		await expect(
			extensionStatusApi(apiRequest(statusUrl, "GET", disabled.key)),
		).resolves.toMatchObject({ status: 401 });

		const expired = await createKey("expired", { orders: ["read"] });
		await db
			.update(apikey)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(apikey.id, expired.id));
		await expect(
			extensionStatusApi(apiRequest(statusUrl, "GET", expired.key)),
		).resolves.toMatchObject({ status: 401 });
	});

	it("reports the owning user on the status endpoint", async () => {
		const key = await createKey("status", { captures: ["write"] });
		const response = await extensionStatusApi(
			apiRequest(statusUrl, "GET", key.key),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			user: { name: "API User A", email: `${userAId}@example.test` },
		});
	});

	it("allows lookups with orders:read, denies without it, and isolates another user's orders", async () => {
		const reader = await createKey("reader", { orders: ["read"] });
		const response = await lookup(reader.key, sharedLookup);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.orders).toEqual([
			expect.objectContaining({
				externalOrderId: "A-100",
				orderId: userAOrderId,
				hasInvoice: false,
			}),
		]);

		const writerOnly = await createKey("captures only", {
			captures: ["write"],
		});
		const denied = await lookup(writerOnly.key, sharedLookup);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ error: { code: "forbidden" } });
	});

	it("returns 400 for malformed JSON and 422 for invalid request data", async () => {
		const reader = await createKey("validation reader", { orders: ["read"] });
		const malformed = new Request(lookupUrl, {
			method: "POST",
			headers: { "x-api-key": reader.key, "content-type": "application/json" },
			body: "{",
		});
		expect((await lookupOrdersApi(malformed)).status).toBe(400);
		const invalid = await lookup(reader.key, {
			source: "not-a-store",
			externalOrderIds: [],
		});
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({
			error: { code: "validation_error", details: expect.any(Array) },
		});
	});

	it("never turns an API key into a browser session", async () => {
		const created = await createKey("no session", { orders: ["read"] });
		await expect(
			auth.api.getSession({
				headers: new Headers({ "x-api-key": created.key }),
			}),
		).resolves.toBeNull();
		const managementResponse = await auth.handler(
			new Request("http://localhost/api/auth/api-key/list", {
				headers: { "x-api-key": created.key },
			}),
		);
		expect(managementResponse.status).toBe(401);
	});

	it("returns 429 when the configured key-level rate limit is exceeded", async () => {
		const limited = await createKey("limited", { orders: ["read"] }, 1);
		expect(
			(await extensionStatusApi(apiRequest(statusUrl, "GET", limited.key)))
				.status,
		).toBe(200);
		const response = await extensionStatusApi(
			apiRequest(statusUrl, "GET", limited.key),
		);
		expect(response.status).toBe(429);
		expect(await response.json()).toMatchObject({
			error: { code: "rate_limited" },
		});
	});
});
