const sensitiveNames = new Set([
	"authorization",
	"cookie",
	"setcookie",
	"xapikey",
	"password",
	"secret",
	"token",
	"accesstoken",
	"refreshtoken",
	"clientsecret",
	"apikey",
	"key",
	"databaseurl",
	"connectionstring",
	"credentials",
	"secretaccesskey",
	"storagesecretaccesskey",
	"storageaccesskeyid",
	"awssecretaccesskey",
	"awsaccesskeyid",
	"otelexporterotlpheaders",
]);
const omittedNames = new Set([
	"body",
	"requestbody",
	"payload",
	"headers",
	"user",
	"session",
	"auth",
	"request",
	"response",
	"query",
	"querystring",
	"url",
]);
const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

// Defense in depth for recognizable credentials. Static messages are still the rule:
// arbitrary secrets embedded in free text cannot be reliably detected.
export function safeText(value: string) {
	return value
		.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"<>]+/gi, "[URL omitted]")
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [Redacted]")
		.replace(/\bapp_[A-Za-z0-9_-]+/g, "[Redacted]")
		.slice(0, 1_000);
}

export function safeError(error: unknown) {
	// Driver, auth and validation messages/causes may contain credentials or input.
	return {
		type:
			error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name)
				? error.name
				: "Error",
		message: "Operation failed",
	};
}

export function sanitize(
	value: unknown,
	additionalSecrets: string[] = [],
	depth = 0,
): unknown {
	if (depth > 8) return "[Omitted]";
	if (value instanceof Error) return safeError(value);
	if (typeof value === "string") return safeText(value);
	if (value === null || typeof value === "boolean" || typeof value === "number")
		return value;
	if (Array.isArray(value))
		return value
			.slice(0, 30)
			.map((item) => sanitize(item, additionalSecrets, depth + 1));
	if (typeof value !== "object" || !value) return undefined;
	const extras = new Set(additionalSecrets.map(normalize));
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value).slice(0, 40)) {
		if (
			["__proto__", "constructor", "prototype", "hasOwnProperty"].includes(key)
		)
			continue;
		const name = normalize(key);
		if (omittedNames.has(name)) continue;
		result[key] =
			sensitiveNames.has(name) ||
			extras.has(name) ||
			/(?:password|secret|token|databaseurl)$/.test(name)
				? "[Redacted]"
				: sanitize(entry, additionalSecrets, depth + 1);
	}
	return result;
}
