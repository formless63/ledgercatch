export interface PublicAsset {
	url: string;
	revision: string;
	integrity: string;
}
export function validBase(base: string) {
	return /^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base);
}
export function validPublicPath(path: string) {
	return (
		/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path) &&
		!/^(api|auth|app|uploads|_server|_build|_nuxt)(?:\/|$)/.test(path)
	);
}
export function cachePrefix(scope: string) {
	return `pwa-offline:v1:${scope}:`;
}
export function cacheableResponse(
	response: Response,
	expectedURL: string,
	html: boolean,
) {
	const control = response.headers.get("cache-control") ?? "";
	const parts = control
		.toLowerCase()
		.split(",")
		.map((part) => part.trim());
	const directives = parts.map((part) => part.split("=")[0].trim());
	const distinct = new Set(directives);
	if (parts.some((part) => !/^[a-z][a-z0-9-]*(?:=[a-z0-9-]+)?$/.test(part)))
		return false;
	const vary = (response.headers.get("vary") ?? "")
		.toLowerCase()
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const type = (response.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return (
		response.status === 200 &&
		response.type === "basic" &&
		!response.redirected &&
		response.url === expectedURL &&
		distinct.size === directives.length &&
		parts.includes("public") &&
		(html || parts.includes("immutable")) &&
		!["private", "no-store", "no-cache"].some((directive) =>
			distinct.has(directive),
		) &&
		vary.every((header) => header === "accept-encoding") &&
		(html ? type === "text/html" : type === "image/png")
	);
}
export function eligibleNavigation(
	request: Request,
	scope: URL,
	paths: readonly string[],
) {
	const url = new URL(request.url);
	return (
		request.method === "GET" &&
		request.mode === "navigate" &&
		url.origin === scope.origin &&
		!url.search &&
		paths.some(
			(path) =>
				validPublicPath(path) && url.pathname === `${scope.pathname}${path}`,
		)
	);
}
