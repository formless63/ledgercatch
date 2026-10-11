/**
 * DB-backed REST checks for the agent API. Needs DATABASE_URL (e.g. load
 * .env.local) and applied migrations; skipped otherwise.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("agent REST API (database)", async () => {
	const { db } = await import("#/db");
	const { apikey, user } = await import("#/db/schema");
	const { auth } = await import("#/lib/auth");
	const { processCapture } = await import("#/features/ledger/process.server");
	const api = await import("./rest.server");

	const ownerId = `agent-api-${crypto.randomUUID()}`;
	const otherId = `agent-api-other-${crypto.randomUUID()}`;
	const keys = { read: "", write: "", admin: "", other: "" };

	const createKey = async (
		userId: string,
		permissions: Record<string, string[]>,
	) =>
		(
			await auth.api.createApiKey({
				body: { userId, name: "agent test", permissions },
			})
		).key;

	const call = (
		method: string,
		path: string,
		key: string,
		body?: unknown,
		headers: Record<string, string> = {},
	) =>
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				authorization: `Bearer ${key}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});

	beforeAll(async () => {
		await db.insert(user).values([
			{ id: ownerId, name: "Agent Owner", email: `${ownerId}@example.test` },
			{ id: otherId, name: "Other", email: `${otherId}@example.test` },
		]);
		keys.read = await createKey(ownerId, { ledger: ["read"] });
		keys.write = await createKey(ownerId, { ledger: ["read", "write"] });
		keys.admin = await createKey(ownerId, {
			ledger: ["read", "write"],
			admin: ["write"],
		});
		keys.other = await createKey(otherId, { ledger: ["read", "write"] });
	});

	afterAll(async () => {
		for (const id of [ownerId, otherId]) {
			await db.delete(apikey).where(eq(apikey.referenceId, id));
			await db.delete(user).where(eq(user.id, id));
		}
	});

	let entityId = "";
	let orderId = "";

	it("returns identity and grants from /me", async () => {
		const response = await api.getMeApi(call("GET", "/api/v1/me", keys.read));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			user: { id: ownerId, name: "Agent Owner" },
			key: { grants: ["ledger:read"] },
			entities: [],
		});
	});

	it("enforces admin:write for settings and is idempotent by name", async () => {
		const body = { name: "Acme LLC", kind: "business", color: "emerald" };
		const denied = await api.createEntityApi(
			call("POST", "/api/v1/entities", keys.write, body),
		);
		expect(denied.status).toBe(403);
		const created = await api.createEntityApi(
			call("POST", "/api/v1/entities", keys.admin, body),
		);
		expect(created.status).toBe(201);
		const first = (await created.json()) as { id: string };
		entityId = first.id;
		const again = await api.createEntityApi(
			call("POST", "/api/v1/entities", keys.admin, {
				...body,
				name: "acme llc",
			}),
		);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ id: entityId, created: false });
	});

	it("ingests structured orders idempotently and triages them", async () => {
		const payload = {
			wait: false,
			orders: [
				{
					externalOrderId: "A-1001",
					merchantName: "Acme Shop",
					orderDate: "2026-09-01",
					currency: "USD",
					totalMinor: 2599,
					items: [
						{ title: "Widget", quantity: 1, totalMinor: 1999 },
						{ title: "Cable", quantity: 2, totalMinor: 600 },
					],
				},
			],
		};
		const headers = { "idempotency-key": `test-${ownerId}` };
		const denied = await api.createOrdersApi(
			call("POST", "/api/v1/orders", keys.read, payload, headers),
		);
		expect(denied.status).toBe(403);
		const first = await api.createOrdersApi(
			call("POST", "/api/v1/orders", keys.write, payload, headers),
		);
		const firstBody = (await first.json()) as {
			results: Array<{ captureId: string; duplicate: boolean }>;
		};
		expect([201, 202]).toContain(first.status);
		const captureId = firstBody.results[0]?.captureId as string;
		expect(firstBody.results[0]?.duplicate).toBe(false);

		await processCapture(captureId);

		const second = await api.createOrdersApi(
			call("POST", "/api/v1/orders", keys.write, payload, headers),
		);
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			results: Array<{
				captureId: string;
				duplicate: boolean;
				orderId: string;
			}>;
		};
		expect(secondBody.results[0]).toMatchObject({
			captureId,
			duplicate: true,
		});
		orderId = secondBody.results[0]?.orderId as string;
		expect(orderId).toBeTruthy();

		const inbox = await api.listOrdersApi(
			call("GET", "/api/v1/orders?view=inbox&limit=5", keys.read),
		);
		expect(await inbox.json()).toMatchObject({
			total: 1,
			limit: 5,
			orders: [{ id: orderId, externalOrderId: "acme-shop:A-1001" }],
		});

		const patched = await api.updateOrderApi(
			call("PATCH", `/api/v1/orders/${orderId}`, keys.write, {
				entityId,
				reviewState: "filed",
				addTags: ["agent"],
			}),
			{ orderId },
		);
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({
			order: { entityId, reviewState: "filed", tags: ["agent"] },
			allocations: [{ entityId, amountMinor: 2599 }],
		});
	});

	it("scopes everything to the key owner", async () => {
		const response = await api.getOrderApi(
			call("GET", `/api/v1/orders/${orderId}`, keys.other),
			{ orderId },
		);
		expect(response.status).toBe(404);
		const malformed = await api.getOrderApi(
			call("GET", "/api/v1/orders/nope", keys.read),
			{ orderId: "nope" },
		);
		expect(malformed.status).toBe(404);
	});

	it("lists claims, captures and rules with pagination envelopes", async () => {
		const claims = await api.listClaimsApi(
			call("GET", "/api/v1/claims", keys.read),
		);
		expect(await claims.json()).toMatchObject({ total: 0, claims: [] });
		const captures = await api.listCapturesApi(
			call("GET", "/api/v1/captures/list?channel=agent", keys.read),
		);
		expect(await captures.json()).toMatchObject({
			total: 1,
			captures: [{ channel: "agent", status: "parsed" }],
		});
		const rule = {
			name: "Acme to business",
			conditions: [{ field: "merchant", op: "contains", value: "Acme" }],
			actions: { entityId },
		};
		const dry = await api.dryRunRuleApi(
			call("POST", "/api/v1/rules/dry-run", keys.read, rule),
		);
		expect(await dry.json()).toMatchObject({ matchCount: 1 });
		const created = await api.createRuleApi(
			call("POST", "/api/v1/rules", keys.admin, rule),
		);
		expect(created.status).toBe(201);
		const invalid = await api.createRuleApi(
			call("POST", "/api/v1/rules", keys.admin, { name: "x" }),
		);
		expect(invalid.status).toBe(422);
	});
});
