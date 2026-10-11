import { createServerFn } from "@tanstack/react-start";
export const loadOps = createServerFn({ method: "GET" }).handler(async () => {
	const { getRequest, setResponseHeader } = await import(
		"@tanstack/react-start/server"
	);
	const { opsResponse } = await import("#/lib/ops.server");
	setResponseHeader("Cache-Control", "private, no-store");
	setResponseHeader("Vary", "Cookie");
	const response = await opsResponse(getRequest());
	return {
		status: response.status,
		body: (await response.json()) as
			| import("./ops.server").OpsSummary
			| { code: string; message: string; retryable: boolean },
	};
});
