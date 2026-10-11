import { randomUUID } from "node:crypto";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
	captureException,
	getLogger,
	getMeter,
	inboundTrace,
	withLogContext,
	withSpan,
} from "./runtime.server";

export function requestId(request: Request) {
	const incoming = request.headers.get("x-request-id");
	return incoming && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(incoming)
		? incoming
		: randomUUID();
}
const methods = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
export function httpMethod(request: Request) {
	return methods.has(request.method) ? request.method : "_OTHER";
}
// Callers supply reviewed, finite route templates; unmatched paths never become labels.
export function routeLabel(request: Request, routes: readonly string[]) {
	const pathname = new URL(request.url).pathname;
	return routes.includes(pathname) ? pathname : "unmatched";
}

export async function observeRequest<T extends { response: Response }>(
	request: Request,
	route: string,
	next: () => Promise<T>,
	id = requestId(request),
): Promise<T> {
	return withLogContext(
		{ requestId: id, component: "http", operation: route },
		() =>
			inboundTrace(request, () =>
				withSpan(
					`${httpMethod(request)} ${route}`,
					async (span) => {
						const start = performance.now();
						let status = 500;
						try {
							const result = await next();
							status = result.response.status;
							// Construct a response rather than mutating potentially immutable fetch headers.
							const response = new Response(
								result.response.body,
								result.response,
							);
							response.headers.set("X-Request-ID", id);
							return { ...result, response };
						} catch (error) {
							// Preserve TanStack redirect/error handling; withSpan captures actual failures.
							if (error instanceof Response) {
								status = error.status;
								const response = new Response(error.body, error);
								response.headers.set("X-Request-ID", id);
								throw response;
							}
							throw error;
						} finally {
							span.setAttribute("http.response.status_code", status);
							if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
							const attributes = {
								"http.request.method": httpMethod(request),
								"http.route": route,
								"http.response.status_code": status,
							};
							const meter = getMeter();
							meter
								.createCounter("http.server.request.count")
								.add(1, attributes);
							meter
								.createHistogram("http.server.request.duration", { unit: "s" })
								.record((performance.now() - start) / 1_000, attributes);
							if (status >= 500)
								meter
									.createCounter("http.server.error.count")
									.add(1, attributes);
							getLogger().info(
								{ status, durationMs: Math.round(performance.now() - start) },
								"Request completed",
							);
						}
					},
					{
						kind: SpanKind.SERVER,
						attributes: {
							"http.request.method": httpMethod(request),
							"http.route": route,
						},
					},
				),
			),
	);
}

// Operation IDs are static contract metadata supplied by native route call sites.
export async function observeApi(
	operationId: string,
	request: Request,
	handler: () => Promise<Response>,
) {
	return withLogContext(
		{ component: "api-platform", operation: operationId },
		() =>
			withSpan(operationId, async (span) => {
				const start = performance.now();
				const response = await handler();
				const attributes = {
					"api.operation_id": operationId,
					"http.request.method": httpMethod(request),
					"http.response.status_code": response.status,
				};
				span.setAttributes(attributes);
				if (response.status >= 500)
					span.setStatus({ code: SpanStatusCode.ERROR });
				getMeter().createCounter("api.request.count").add(1, attributes);
				getMeter()
					.createHistogram("api.request.duration", { unit: "s" })
					.record((performance.now() - start) / 1_000, attributes);
				if ([401, 403].includes(response.status))
					getMeter().createCounter("api.auth.failure.count").add(1, attributes);
				getLogger().info(
					{ status: response.status },
					"API operation completed",
				);
				return response;
			}),
	);
}

// Bounded queue names come from the application's registered Jobs set; IDs stay in logs.
export async function observeJob<T>(
	job: { name: string; id: string },
	handler: () => Promise<T>,
) {
	return withLogContext(
		{
			component: "jobs",
			operation: "execute",
			jobName: job.name,
			jobId: job.id,
		},
		() =>
			withSpan(
				`job ${job.name}`,
				async (span) => {
					const start = performance.now();
					let outcome = "success";
					span.setAttributes({
						"messaging.system": "pgboss",
						"messaging.destination.name": job.name,
						"messaging.operation.type": "process",
						"messaging.message.id": job.id,
					});
					getLogger().info({}, "Job started");
					try {
						return await handler();
					} catch (error) {
						outcome = "failure";
						throw error;
					} finally {
						const attributes = {
							"messaging.destination.name": job.name,
							outcome,
						};
						getMeter().createCounter("job.execution.count").add(1, attributes);
						getMeter()
							.createHistogram("job.execution.duration", { unit: "s" })
							.record((performance.now() - start) / 1_000, attributes);
						if (outcome === "failure")
							getMeter().createCounter("job.failure.count").add(1, attributes);
						getLogger().info(
							{ outcome, durationMs: Math.round(performance.now() - start) },
							"Job completed",
						);
					}
				},
				{ kind: SpanKind.CONSUMER },
			),
	);
}

export function captureHealthFailure(error: unknown) {
	captureException(error, { component: "health", operation: "readiness" });
}
