/** Shared, code-free configuration and bounded OpenAPI inspection. */
import { z } from "zod";
import type { ExpensePayload } from "./types";
import { mappingConfigSchema } from "./types";

const key = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
	.refine((s) => !["constructor", "prototype", "__proto__"].includes(s));
const path = z
	.string()
	.max(500)
	.regex(/^\/[A-Za-z0-9/_{}.-]*$/)
	.refine((s) => !s.startsWith("//") && !s.split("/").includes(".."));
const sourceTypes = {
	reference: "string",
	orderRef: "string",
	date: "string",
	vendorName: "string",
	amount: "string",
	currency: "string",
	memo: "string",
	expenseAccountId: "string",
	paymentAccountId: "string",
	reimbursable: "boolean",
	lineSummary: "string[]",
} as const;
const mapping = z
	.object({
		target: key,
		source: z.enum(
			Object.keys(sourceTypes) as [
				keyof typeof sourceTypes,
				...(keyof typeof sourceTypes)[],
			],
		),
		type: z.enum(["string", "boolean", "string[]"]),
	})
	.strict()
	.refine(
		(m) => sourceTypes[m.source] === m.type,
		"Mapping type must match the expense field; amounts are exact decimal strings",
	);
const header = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)
	.refine(
		(v) =>
			![
				"host",
				"cookie",
				"content-length",
				"content-type",
				"connection",
				"transfer-encoding",
				"authorization",
				"proxy-authorization",
			].includes(v.toLowerCase()),
		"Reserved header",
	);
export const httpDefinitionSchema = z
	.object({
		test: z
			.object({
				method: z.literal("GET"),
				path: path.refine((p) => !/[{}]/.test(p)),
			})
			.strict(),
		expense: z
			.object({
				method: z.enum(["POST", "PUT"]),
				path: path.refine((p) => !/[{}]/.test(p)),
				fields: z.array(mapping).min(1).max(40),
				resultId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,127}$/),
				idempotencyHeader: header,
				idempotencyConfirmed: z.literal(true),
			})
			.strict(),
		attachment: z
			.object({
				method: z.literal("POST"),
				path: path.refine(
					(p) =>
						(p.match(/\{id\}/g) ?? []).length === 1 &&
						!/[{}]/.test(p.replace("{id}", "")),
				),
				fileField: key,
				maxBytes: z
					.number()
					.int()
					.min(1)
					.max(10 * 1024 * 1024),
				idempotencyHeader: header,
				idempotencyConfirmed: z.literal(true),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		const fields = v.expense.fields;
		if (new Set(fields.map((f) => f.target)).size !== fields.length)
			ctx.addIssue({ code: "custom", message: "Duplicate target field" });
		if (!fields.some((f) => f.source === "reference"))
			ctx.addIssue({
				code: "custom",
				message: "Map the stable reference for reconciliation",
			});
	});
export type HttpDefinition = z.output<typeof httpDefinitionSchema>;
export function parseDefinition(text: string): HttpDefinition {
	if (new TextEncoder().encode(text).length > 32_768)
		throw new Error("HTTP definition exceeds 32 KiB");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("HTTP definition must be JSON");
	}
	return httpDefinitionSchema.parse(parsed);
}
export const customHttpConfigSchema = mappingConfigSchema
	.extend({
		baseUrl: z
			.url({ protocol: /^https?$/ })
			.refine((s) => {
				const u = new URL(s);
				return (
					!u.username &&
					!u.password &&
					!u.search &&
					!u.hash &&
					u.pathname === "/"
				);
			}, "Use an origin only, with no credentials, query or path")
			.transform((s) => new URL(s).origin),
		auth: z.enum(["none", "bearer", "api_key"]).default("bearer"),
		authHeader: header.default("X-API-Key"),
		definition: z
			.string()
			.max(32_768)
			.superRefine((s, ctx) => {
				try {
					parseDefinition(s);
				} catch {
					ctx.addIssue({
						code: "custom",
						message:
							"Invalid HTTP definition: check operations, typed mappings and idempotency confirmation",
					});
				}
			}),
	})
	.superRefine((config, ctx) => {
		if (config.auth !== "api_key") return;
		let value: unknown;
		try {
			value = JSON.parse(config.definition);
		} catch {
			return;
		}
		const parsed = httpDefinitionSchema.safeParse(value);
		if (!parsed.success) return;
		if (
			[
				parsed.data.expense.idempotencyHeader,
				parsed.data.attachment?.idempotencyHeader,
			].some((h) => h?.toLowerCase() === config.authHeader.toLowerCase())
		)
			ctx.addIssue({
				code: "custom",
				path: ["authHeader"],
				message: "Authentication and idempotency must use different headers",
			});
	});
export const customHttpSecretSchema = z
	.object({
		token: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[\x21-\x7e]+$/)
			.optional(),
	})
	.strict();
export type CustomHttpConfig = z.output<typeof customHttpConfigSchema>;
export type CustomHttpSecret = z.output<typeof customHttpSecretSchema>;
export function previewExpense(
	definition: HttpDefinition,
	payload: Omit<ExpensePayload, "documents">,
) {
	return Object.fromEntries(
		definition.expense.fields.map((m) => [m.target, payload[m.source] ?? null]),
	);
}
export interface ImportedOperation {
	method: "GET" | "POST" | "PUT";
	path: string;
	summary: string;
	requestSchema: unknown;
}
export function inspectOpenApi(text: string): ImportedOperation[] {
	if (new TextEncoder().encode(text).length > 256 * 1024)
		throw new Error("OpenAPI document exceeds 256 KiB");
	const doc = JSON.parse(text) as Record<string, unknown>;
	let nodes = 0;
	function walk(v: unknown, depth: number) {
		if (++nodes > 10_000 || depth > 20)
			throw new Error("OpenAPI document is too complex");
		if (v && typeof v === "object")
			for (const [k, x] of Object.entries(v)) {
				if (
					[
						"$ref",
						"callbacks",
						"webhooks",
						"links",
						"x-code",
						"__proto__",
						"constructor",
						"prototype",
					].includes(k)
				)
					throw new Error(
						"Only inline schemas are supported; references, callbacks and code are not imported",
					);
				walk(x, depth + 1);
			}
	}
	walk(doc, 0);
	if (!/^3\.(0|1)\./.test(String(doc.openapi)))
		throw new Error("Use OpenAPI 3.0 or 3.1 JSON");
	if (!doc.paths || typeof doc.paths !== "object" || Array.isArray(doc.paths))
		throw new Error("Missing paths");
	const out: ImportedOperation[] = [];
	for (const [p, item] of Object.entries(doc.paths)) {
		if (!path.safeParse(p).success || !item || typeof item !== "object")
			throw new Error("Unsupported path");
		for (const [method, op] of Object.entries(item)) {
			if (!["get", "post", "put"].includes(method)) continue;
			if (!op || typeof op !== "object") throw new Error("Invalid operation");
			const o = op as {
				summary?: unknown;
				requestBody?: { content?: Record<string, { schema?: unknown }> };
			};
			out.push({
				method: method.toUpperCase() as ImportedOperation["method"],
				path: p,
				summary: typeof o.summary === "string" ? o.summary.slice(0, 200) : "",
				requestSchema:
					o.requestBody?.content?.["application/json"]?.schema ?? null,
			});
			if (out.length > 100) throw new Error("Too many operations");
		}
	}
	return out;
}
export const exampleDefinition: HttpDefinition = {
	test: { method: "GET", path: "/health" },
	expense: {
		method: "POST",
		path: "/expenses",
		fields: [
			{ target: "reference", source: "reference", type: "string" },
			{ target: "amount", source: "amount", type: "string" },
			{ target: "currency", source: "currency", type: "string" },
			{ target: "vendor", source: "vendorName", type: "string" },
		],
		resultId: "id",
		idempotencyHeader: "Idempotency-Key",
		idempotencyConfirmed: true,
	},
};
