import { validate } from "@scalar/openapi-parser";
import { describe, expect, it } from "vitest";
import { createOpenApiDocument } from "./openapi";

describe("API Platform OpenAPI document", () => {
	it("generates deterministic, valid OpenAPI 3.1.1 from registered contracts", async () => {
		const first = createOpenApiDocument();
		const second = createOpenApiDocument();
		expect(first).toEqual(second);
		expect(first.openapi).toBe("3.1.1");
		await expect(
			validate(JSON.stringify(first), { throwOnError: true }),
		).resolves.toMatchObject({
			valid: true,
		});
	});

	it("contains only deliberate external operations with unique IDs and security metadata", () => {
		const document = createOpenApiDocument();
		const paths = document.paths ?? {};
		expect(Object.keys(paths)).toEqual(
			expect.arrayContaining([
				"/api/v1/captures",
				"/api/v1/documents",
				"/api/v1/extension/status",
				"/api/v1/orders/lookup",
				"/api/v1/me",
				"/api/v1/orders",
				"/api/v1/orders/{orderId}",
				"/api/v1/claims",
				"/api/v1/rules/dry-run",
			]),
		);
		expect(
			Object.keys(paths).every((path) => path.startsWith("/api/v1/")),
		).toBe(true);
		expect(paths["/api/auth/$"]).toBeUndefined();
		expect(paths["/api/health"]).toBeUndefined();

		const operations = Object.values(paths).flatMap((path) =>
			Object.values(path).filter(
				(value): value is { operationId: string } =>
					typeof value === "object" && value !== null && "operationId" in value,
			),
		);
		const operationIds = operations.map(({ operationId }) => operationId);
		expect(new Set(operationIds).size).toBe(operationIds.length);
		expect(operationIds).toEqual(
			expect.arrayContaining([
				"createCapture",
				"uploadDocument",
				"getExtensionStatus",
				"lookupOrders",
				"getMe",
				"listLedgerOrders",
				"createLedgerOrders",
			]),
		);
		expect(document.components?.securitySchemes?.ApiKeyAuth).toMatchObject({
			type: "apiKey",
			in: "header",
			name: "X-API-Key",
		});
		expect(paths["/api/v1/extension/status"]?.get).toMatchObject({
			security: [{ ApiKeyAuth: [] }],
			"x-required-permissions": {},
		});
		expect(paths["/api/v1/captures"]?.post).toMatchObject({
			security: [{ ApiKeyAuth: [] }],
			"x-required-permissions": { captures: ["write"] },
		});
		expect(paths["/api/v1/documents"]?.post).toMatchObject({
			security: [{ ApiKeyAuth: [] }],
			"x-required-permissions": { captures: ["write"] },
		});
		expect(paths["/api/v1/orders/lookup"]?.post).toMatchObject({
			security: [{ ApiKeyAuth: [] }],
			"x-required-permissions": { orders: ["read"] },
		});
	});

	it("documents the agent ledger API with grants, bearer auth and pagination", () => {
		const document = createOpenApiDocument();
		const paths = document.paths ?? {};
		expect(document.components?.securitySchemes?.BearerAuth).toMatchObject({
			type: "http",
			scheme: "bearer",
		});
		expect(paths["/api/v1/me"]?.get).toMatchObject({
			security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
			"x-required-permissions": {},
		});
		expect(paths["/api/v1/orders"]?.get).toMatchObject({
			"x-required-permissions": { ledger: ["read"] },
		});
		expect(paths["/api/v1/orders"]?.post).toMatchObject({
			"x-required-permissions": { ledger: ["write"] },
		});
		expect(paths["/api/v1/rules"]?.post).toMatchObject({
			"x-required-permissions": { admin: ["write"] },
		});
		const listParams = (paths["/api/v1/orders"]?.get?.parameters ??
			[]) as Array<{
			name: string;
			in: string;
		}>;
		expect(listParams.map((p) => p.name)).toEqual(
			expect.arrayContaining(["view", "entityId", "q", "limit", "offset"]),
		);
		const orderParams = (paths["/api/v1/orders/{orderId}"]?.patch?.parameters ??
			[]) as Array<{ name: string; in: string }>;
		expect(orderParams).toEqual([
			expect.objectContaining({ name: "orderId", in: "path" }),
		]);
		for (const [path, item] of Object.entries(paths))
			for (const operation of Object.values(item))
				if (
					operation &&
					typeof operation === "object" &&
					"operationId" in operation
				)
					expect(
						(operation as { description?: string }).description,
						path,
					).toBeTruthy();
	});

	it("publishes the shared capture contract and a multipart document upload", () => {
		const document = createOpenApiDocument();
		expect(
			document.paths?.["/api/v1/captures"]?.post?.requestBody,
		).toMatchObject({
			content: {
				"application/json": {
					schema: {
						properties: {
							captureId: { format: "uuid" },
							source: { enum: expect.arrayContaining(["aliexpress"]) },
						},
					},
				},
			},
		});
		expect(
			document.paths?.["/api/v1/documents"]?.post?.requestBody,
		).toMatchObject({
			content: { "multipart/form-data": { schema: expect.anything() } },
		});
		expect(
			document.paths?.["/api/v1/orders/lookup"]?.post?.requestBody,
		).toMatchObject({
			content: {
				"application/json": {
					schema: {
						properties: { externalOrderIds: { maxItems: 200 } },
					},
				},
			},
		});
	});
});
