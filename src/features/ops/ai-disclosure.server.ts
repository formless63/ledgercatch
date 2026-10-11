/**
 * Risk 12: what AI extraction sends and where. Exposes only the endpoint
 * host (never the key, path or query) and whether it looks local.
 */
const DEFAULT_HOST = "api.openai.com";

/** localhost, loopback, RFC 1918 / ULA / link-local, .local/.internal/.lan, or a bare Docker service name. */
export function isLocalHost(host: string) {
	const h = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (!h) return false;
	if (h === "localhost" || h === "::1" || h.endsWith(".localhost")) return true;
	if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h))
		return true;
	if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
	if (/\.(local|internal|lan|home\.arpa)$/.test(h)) return true;
	return !h.includes(".") && !h.includes(":");
}

export type AiDisclosure = {
	configured: boolean;
	/** host[:port] of AI_BASE_URL, the provider default when unset, null when invalid. */
	host: string | null;
	usesDefaultEndpoint: boolean;
	local: boolean;
};

export function aiDisclosure(
	env: NodeJS.ProcessEnv = process.env,
): AiDisclosure {
	// Same rule as aiConfigured() in parsing/ai-extract.server.ts.
	const configured = Boolean(env.AI_MODEL?.trim());
	const raw = env.AI_BASE_URL?.trim();
	if (!raw)
		return {
			configured,
			host: DEFAULT_HOST,
			usesDefaultEndpoint: true,
			local: false,
		};
	try {
		const url = new URL(raw);
		return {
			configured,
			host: url.host,
			usesDefaultEndpoint: false,
			local: isLocalHost(url.hostname),
		};
	} catch {
		return { configured, host: null, usesDefaultEndpoint: false, local: false };
	}
}
