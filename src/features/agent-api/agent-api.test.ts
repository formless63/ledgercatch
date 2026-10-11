import { describe, expect, it } from "vitest";
import {
	AGENT_PERMISSION_PRESETS,
	apiPermissionsSchema,
	describePermissionGrants,
	EXTENSION_PERMISSIONS,
	hasRequiredPermissions,
	toApiPermissions,
} from "#/integrations/api-platform/permissions";
import { ApiHttpError } from "#/integrations/api-platform/responses";
import { extractApiKey, toApiError } from "./http.server";
import { PERMISSIONS } from "./permissions";
import {
	createOrdersBody,
	orderListQuery,
	orderPatchBody,
	queueExportBody,
	splitOrderBody,
} from "./schemas";

const uuid = "4b0b7a3e-3f2c-4c55-9a43-2b1f1c0d9e11";

describe("agent API permissions", () => {
	it("parses legacy extension keys with empty ledger/admin grants", () => {
		const legacy = apiPermissionsSchema.parse({
			captures: ["write"],
			orders: ["read"],
		});
		expect(legacy).toEqual({
			captures: ["write"],
			orders: ["read"],
			ledger: [],
			admin: [],
		});
		expect(hasRequiredPermissions(legacy, PERMISSIONS.read)).toBe(false);
		expect(hasRequiredPermissions(legacy, PERMISSIONS.any)).toBe(true);
		expect(toApiPermissions(EXTENSION_PERMISSIONS)).toEqual(legacy);
	});

	it("maps agent presets to the expected levels", () => {
		const readOnly = toApiPermissions(
			AGENT_PERMISSION_PRESETS.readOnly.permissions,
		);
		const readWrite = toApiPermissions(
			AGENT_PERMISSION_PRESETS.readWrite.permissions,
		);
		const admin = toApiPermissions(AGENT_PERMISSION_PRESETS.admin.permissions);
		const can = (p: typeof admin) =>
			(["any", "read", "write", "admin"] as const).filter((level) =>
				hasRequiredPermissions(p, PERMISSIONS[level]),
			);
		expect(can(readOnly)).toEqual(["any", "read"]);
		expect(can(readWrite)).toEqual(["any", "read", "write"]);
		expect(can(admin)).toEqual(["any", "read", "write", "admin"]);
		expect(describePermissionGrants(admin)).toEqual([
			"ledger:read",
			"ledger:write",
			"admin:write",
		]);
	});

	it("rejects unknown actions", () => {
		expect(apiPermissionsSchema.safeParse({ ledger: ["delete"] }).success).toBe(
			false,
		);
	});
});

describe("agent API request helpers", () => {
	it("accepts X-API-Key or a Bearer token", () => {
		const req = (headers: Record<string, string>) =>
			new Request("http://x/", { headers });
		expect(extractApiKey(req({ "x-api-key": " k1 " }))).toBe("k1");
		expect(extractApiKey(req({ authorization: "Bearer k2" }))).toBe("k2");
		expect(extractApiKey(req({ authorization: "Basic abc" }))).toBeNull();
		expect(extractApiKey(req({}))).toBeNull();
	});

	it("maps ledger errors to API errors", () => {
		const notFound = toApiError(new Error("NOT_FOUND"));
		expect(notFound).toBeInstanceOf(ApiHttpError);
		expect((notFound as ApiHttpError).status).toBe(404);
		const unknown = toApiError(new Error("Unknown entity"));
		expect((unknown as ApiHttpError).status).toBe(422);
		const internal = new Error("connection refused");
		expect(toApiError(internal)).toBe(internal);
	});
});

describe("agent API input validation", () => {
	it("coerces order list query strings", () => {
		const parsed = orderListQuery.parse({
			view: "inbox",
			missingInvoice: "true",
			limit: "10",
			offset: "20",
		});
		expect(parsed).toMatchObject({
			view: "inbox",
			missingInvoice: true,
			limit: 10,
			offset: 20,
			sort: "date_desc",
		});
		expect(orderListQuery.safeParse({ limit: "501" }).success).toBe(false);
		expect(orderListQuery.parse({}).limit).toBe(50);
	});

	it("validates structured orders", () => {
		const parsed = createOrdersBody.parse({
			orders: [
				{
					externalOrderId: "1001",
					merchantName: "Acme",
					currency: "usd",
					totalMinor: 1234,
					items: [{ title: "Widget" }],
					triage: { entityId: uuid, reviewState: "filed" },
				},
			],
		});
		expect(parsed.source).toBe("generic");
		expect(parsed.wait).toBe(true);
		expect(parsed.orders[0]?.currency).toBe("USD");
		expect(parsed.orders[0]?.items?.[0]?.quantity).toBe(1);
		expect(
			createOrdersBody.safeParse({ orders: [{ totalMinor: 1.5 }] }).success,
		).toBe(false);
		expect(createOrdersBody.safeParse({ orders: [] }).success).toBe(false);
		expect(
			createOrdersBody.safeParse({
				orders: [{ externalOrderId: "x", paymentLast4: "12a4" }],
			}).success,
		).toBe(false);
	});

	it("validates order patches, splits and exports", () => {
		expect(orderPatchBody.parse({ entityId: null, addTags: ["a"] })).toEqual({
			entityId: null,
			addTags: ["a"],
		});
		expect(orderPatchBody.safeParse({ reviewState: "done" }).success).toBe(
			false,
		);
		expect(
			splitOrderBody.safeParse({ items: [{ itemId: "nope" }] }).success,
		).toBe(false);
		expect(queueExportBody.safeParse({}).success).toBe(false);
		expect(queueExportBody.parse({ orderIds: [uuid] }).force).toBe(false);
	});
});
