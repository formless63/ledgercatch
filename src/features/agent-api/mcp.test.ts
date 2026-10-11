import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHttpError } from "#/integrations/api-platform/responses";

const keys = {
	"read-key": { ledger: ["read"] },
	"write-key": { ledger: ["read", "write"] },
} as const;

vi.mock("#/integrations/api-platform/principal.server", () => ({
	requireApiKey: vi.fn(async (request: Request) => {
		const key = request.headers.get("x-api-key") as keyof typeof keys | null;
		const granted = key ? keys[key] : undefined;
		if (!granted) throw new ApiHttpError(401, "unauthorized", "bad key");
		return {
			type: "user",
			userId: "user-1",
			keyId: `id-${key}`,
			permissions: {
				captures: [],
				orders: [],
				admin: [],
				ledger: [...granted.ledger],
			},
		};
	}),
}));

vi.mock("./service.server", () => ({
	getMe: vi.fn(async () => ({ user: { id: "user-1" }, entities: [] })),
	listOrders: vi.fn(async (_owner: string, input: { limit: number }) => ({
		total: 0,
		limit: input.limit,
		offset: 0,
		orders: [],
	})),
	createOrders: vi.fn(async () => ({ pending: false, results: [] })),
}));

const { handleMcpRequest, agentTools } = await import("./mcp.server");
const service = await import("./service.server");

let nextId = 1;
function rpc(
	method: string,
	params: Record<string, unknown> | undefined,
	key?: string,
) {
	return handleMcpRequest(
		new Request("http://localhost/api/mcp", {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				...(key ? { authorization: `Bearer ${key}` } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
		}),
	);
}

type ToolResult = {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
};

async function callTool(name: string, args: unknown, key: string) {
	const response = await rpc("tools/call", { name, arguments: args }, key);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { result: ToolResult };
	return {
		...body.result,
		data: JSON.parse(body.result.content[0]?.text ?? "null"),
	};
}

describe("MCP endpoint", () => {
	beforeEach(() => vi.clearAllMocks());

	it("rejects requests without a valid key", async () => {
		const response = await rpc("tools/list", {});
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Bearer");
		expect(await response.json()).toMatchObject({
			error: { code: "unauthorized" },
		});
	});

	it("only accepts POST", async () => {
		const response = await handleMcpRequest(
			new Request("http://localhost/api/mcp", { method: "GET" }),
		);
		expect(response.status).toBe(405);
	});

	it("initializes and lists tools with JSON schemas", async () => {
		const init = await rpc(
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			},
			"read-key",
		);
		expect(init.status).toBe(200);
		expect(await init.json()).toMatchObject({
			result: {
				serverInfo: { name: "ledgercatch" },
				capabilities: { tools: {} },
			},
		});

		const list = await rpc("tools/list", {}, "read-key");
		const body = (await list.json()) as {
			result: {
				tools: Array<{
					name: string;
					description: string;
					inputSchema: { type: string; properties?: Record<string, unknown> };
				}>;
			};
		};
		const names = body.result.tools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"get_started",
				"whoami",
				"list_orders",
				"list_inbox",
				"get_order",
				"create_order",
				"update_order",
				"bulk_update_orders",
				"assign_item",
				"file_orders",
				"set_reimbursement",
				"create_claim",
				"list_claims",
				"list_entities",
				"list_categories",
				"list_payment_methods",
				"upsert_rule",
				"dry_run_rule",
				"apply_rules",
				"list_captures",
				"reprocess_capture",
				"queue_export",
				"get_insights",
			]),
		);
		expect(names.length).toBe(agentTools.length);
		for (const t of body.result.tools) {
			expect(t.inputSchema.type).toBe("object");
			expect(t.description).toMatch(/\[requires: /);
		}
		const createOrder = body.result.tools.find(
			(t) => t.name === "create_order",
		);
		expect(Object.keys(createOrder?.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(["source", "orders", "idempotencyKey"]),
		);
	});

	it("runs a permitted tool and returns JSON text content", async () => {
		const result = await callTool("list_inbox", { limit: 5 }, "read-key");
		expect(result.isError).toBeUndefined();
		expect(result.data).toMatchObject({ total: 0, limit: 5 });
		expect(service.listOrders).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({ view: "inbox", limit: 5 }),
		);
	});

	it("returns a forbidden tool error when the key lacks the grant", async () => {
		const result = await callTool(
			"create_order",
			{ orders: [{ externalOrderId: "1" }] },
			"read-key",
		);
		expect(result.isError).toBe(true);
		expect(result.data).toMatchObject({ error: { code: "forbidden" } });
		expect(service.createOrders).not.toHaveBeenCalled();
	});

	it("validates tool arguments", async () => {
		const result = await callTool("create_order", { orders: [] }, "write-key");
		expect(result.isError).toBe(true);
		expect(result.data).toMatchObject({ error: { code: "validation_error" } });
	});

	it("passes the idempotency key through on create_order", async () => {
		const result = await callTool(
			"create_order",
			{ idempotencyKey: "abc-1", orders: [{ externalOrderId: "1" }] },
			"write-key",
		);
		expect(result.isError).toBeUndefined();
		expect(service.createOrders).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({ source: "generic" }),
			"abc-1",
		);
	});

	it("serves the workflow guide", async () => {
		const result = await callTool("get_started", {}, "read-key");
		expect(result.data.guide).toContain("Triage loop");
	});
});
