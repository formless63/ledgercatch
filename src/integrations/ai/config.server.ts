import { AiError } from "./errors.server";
export interface AiConfig {
	provider: "openai-compatible";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	timeoutSeconds: number;
}
export function validateAiConfig(
	config: AiConfig,
	env: NodeJS.ProcessEnv = process.env,
): AiConfig {
	try {
		if (
			typeof window !== "undefined" ||
			!config ||
			config.provider !== "openai-compatible" ||
			typeof config.model !== "string" ||
			Array.from(config.model).length < 1 ||
			Array.from(config.model).length > 128 ||
			Buffer.from(config.model).toString() !== config.model ||
			/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(config.model) ||
			!config.model.trim() ||
			!Number.isInteger(config.timeoutSeconds) ||
			config.timeoutSeconds < 1 ||
			config.timeoutSeconds > 300 ||
			(config.apiKey !== undefined &&
				(typeof config.apiKey !== "string" ||
					/^[ \t]|[ \t]$/.test(config.apiKey) ||
					Buffer.from(config.apiKey).toString() !== config.apiKey ||
					Array.from(config.apiKey).some((char) => {
						const code = char.charCodeAt(0);
						return code < 32 || (code >= 127 && code <= 159) || code > 255;
					})))
		)
			throw new Error();
		if (config.apiKey) {
			const authorization = `Bearer ${config.apiKey}`;
			if (
				new Headers({ Authorization: authorization }).get("Authorization") !==
				authorization
			)
				throw new Error();
		}
		if (config.baseUrl !== undefined) {
			const url = new URL(config.baseUrl);
			// Check the original authority: URL normalizes abbreviated/integer/hex IPv4.
			const local =
				/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(
					config.baseUrl,
				);
			if (
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				(url.protocol !== "https:" &&
					!(
						url.protocol === "http:" &&
						local &&
						["development", "test"].includes(env.NODE_ENV ?? "")
					))
			)
				throw new Error();
		}
		return {
			provider: config.provider,
			model: config.model,
			timeoutSeconds: config.timeoutSeconds,
			...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
			...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
		};
	} catch {
		throw new AiError("configuration");
	}
}
export function resolveAiConfig(
	env: NodeJS.ProcessEnv = process.env,
): AiConfig {
	const timeout = env.AI_TIMEOUT_SECONDS ?? "60";
	if (!/^\d+$/.test(timeout)) throw new AiError("configuration");
	return validateAiConfig(
		{
			provider: (env.AI_PROVIDER ??
				"openai-compatible") as AiConfig["provider"],
			model: env.AI_MODEL ?? "",
			apiKey: env.AI_API_KEY,
			baseUrl: env.AI_BASE_URL,
			timeoutSeconds: Number(timeout),
		},
		env,
	);
}
