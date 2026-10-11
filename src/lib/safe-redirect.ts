const LOCAL_ORIGIN = "http://local.invalid";

export function safeInternalRedirect(
	value: string | undefined,
	fallback = "/app",
) {
	if (!value?.startsWith("/") || value.startsWith("//")) return fallback;

	try {
		const target = new URL(value, LOCAL_ORIGIN);
		if (target.origin !== LOCAL_ORIGIN) return fallback;
		return `${target.pathname}${target.search}${target.hash}`;
	} catch {
		return fallback;
	}
}
