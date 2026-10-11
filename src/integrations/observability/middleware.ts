import { createMiddleware } from "@tanstack/react-start";

export function observabilityMiddleware(
	routes: readonly string[] = ["/", "/api/health"],
) {
	return createMiddleware().server(async ({ request, next, handlerType }) => {
		const { observeRequest, requestId, routeLabel } = await import(
			"./http.server"
		);
		const { setResponseHeader } = await import("@tanstack/react-start/server");
		const id = requestId(request);
		setResponseHeader("X-Request-ID", id);
		return observeRequest(
			request,
			handlerType === "serverFn"
				? "server-function"
				: routeLabel(request, routes),
			async () => next(),
			id,
		);
	});
}
