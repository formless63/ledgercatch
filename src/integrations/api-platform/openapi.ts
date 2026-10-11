import { createDocument, type ZodOpenApiPathsObject } from "zod-openapi";
import { appName } from "#/lib/app-name";
import { apiOperations, apiTags } from "./extension.contracts";
import { ledgerApiOperations, ledgerApiTags } from "./ledger.contracts";

export function createOpenApiDocument() {
	const operationIds = new Set<string>();
	const paths: ZodOpenApiPathsObject = {};
	const bearerCapable = new Set(ledgerApiOperations);

	for (const operation of [...apiOperations, ...ledgerApiOperations].sort(
		(a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`),
	)) {
		if (operationIds.has(operation.operationId)) {
			throw new Error(`Duplicate API operationId: ${operation.operationId}`);
		}
		operationIds.add(operation.operationId);

		const responses = Object.fromEntries(
			Object.entries(operation.responses)
				.sort(([left], [right]) => Number(left) - Number(right))
				.map(([status, response]) => [
					status,
					{
						description: response.description,
						...(response.schema
							? {
									content: {
										"application/json": { schema: response.schema },
									},
								}
							: {}),
					},
				]),
		);

		if (!paths[operation.path]) paths[operation.path] = {};
		const pathItem = paths[operation.path];
		pathItem[
			operation.method.toLowerCase() as Lowercase<typeof operation.method>
		] = {
			operationId: operation.operationId,
			summary: operation.summary,
			description: operation.description,
			tags: operation.tags,
			...(operation.pathParams || operation.queryParams
				? {
						requestParams: {
							...(operation.pathParams ? { path: operation.pathParams } : {}),
							...(operation.queryParams
								? { query: operation.queryParams }
								: {}),
						},
					}
				: {}),
			...(operation.requestBody
				? {
						requestBody: {
							required: true,
							content: {
								[operation.requestContentType ?? "application/json"]: {
									schema: operation.requestBody,
								},
							},
						},
					}
				: {}),
			responses,
			security: operation.machineAuth
				? bearerCapable.has(operation)
					? [{ ApiKeyAuth: [] }, { BearerAuth: [] }]
					: [{ ApiKeyAuth: [] }]
				: [],
			"x-required-permissions": operation.permissions,
		};
	}

	return createDocument({
		openapi: "3.1.1",
		info: {
			title: `${appName} API`,
			version: "1.0.0",
			description: `Versioned external machine API for ${appName}. Coding agents: start with \`GET /api/v1/me\`; the same operations are available as MCP tools at \`POST /api/mcp\` (Streamable HTTP, stateless). Errors use \`{ error: { code, message, details? } }\`; list endpoints page with \`limit\`/\`offset\` and return \`total\`.`,
		},
		tags: [...ledgerApiTags, ...apiTags],
		paths,
		components: {
			securitySchemes: {
				ApiKeyAuth: {
					type: "apiKey",
					in: "header",
					name: "X-API-Key",
					description:
						"A user-owned API key. Raw keys are shown only once at creation.",
				},
				BearerAuth: {
					type: "http",
					scheme: "bearer",
					description:
						"The same API key as `Authorization: Bearer <key>` (agent API and MCP; the browser-extension routes accept only X-API-Key).",
				},
			},
		},
	});
}
