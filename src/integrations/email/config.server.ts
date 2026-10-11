import { EmailError } from "./errors.server";

export interface EmailAddress {
	address: string;
	name?: string;
}
export interface EmailConfig {
	host: string;
	port: number;
	security: "tls" | "starttls" | "opportunistic";
	user?: string;
	password?: string;
	from: EmailAddress;
	replyTo?: EmailAddress;
	maxRecipients: number;
}
export function header(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!Array.from(value).some((char) => {
			const code = char.charCodeAt(0);
			return (
				code < 32 ||
				(code >= 127 && code <= 159) ||
				code === 8232 ||
				code === 8233
			);
		})
	);
}
export function address(value: unknown): EmailAddress {
	const item = value as EmailAddress | undefined;
	if (
		!item ||
		typeof item !== "object" ||
		Object.keys(item).some((key) => !["address", "name"].includes(key)) ||
		!header(item.address, 254) ||
		!/^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+$/.test(item.address) ||
		(item.name !== undefined && !header(item.name, 128))
	)
		throw new EmailError("message");
	return { address: item.address, ...(item.name ? { name: item.name } : {}) };
}
export function validateEmailConfig(config: EmailConfig): EmailConfig {
	try {
		if (
			!config ||
			Object.keys(config).some(
				(key) =>
					![
						"host",
						"port",
						"security",
						"user",
						"password",
						"from",
						"replyTo",
						"maxRecipients",
					].includes(key),
			) ||
			!header(config.host, 253) ||
			/[\s/:@]/.test(config.host) ||
			!Number.isInteger(config.port) ||
			config.port < 1 ||
			config.port > 65535 ||
			!["tls", "starttls", "opportunistic"].includes(config.security) ||
			!!config.user !== !!config.password ||
			(config.user !== undefined && !header(config.user, 512)) ||
			(config.password !== undefined && !header(config.password, 4096)) ||
			!Number.isInteger(config.maxRecipients) ||
			config.maxRecipients < 1 ||
			config.maxRecipients > 100
		)
			throw new Error();
		return {
			...config,
			from: address(config.from),
			...(config.replyTo ? { replyTo: address(config.replyTo) } : {}),
		};
	} catch (cause) {
		throw new EmailError("configuration", false, cause);
	}
}
export function resolveEmailConfig(
	env: NodeJS.ProcessEnv = process.env,
): EmailConfig {
	return validateEmailConfig({
		host: env.SMTP_HOST ?? "",
		port: Number(env.SMTP_PORT),
		security: env.SMTP_SECURITY as EmailConfig["security"],
		...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
		...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
		from: {
			address: env.EMAIL_FROM_ADDRESS ?? "",
			...(env.EMAIL_FROM_NAME ? { name: env.EMAIL_FROM_NAME } : {}),
		},
		...(env.EMAIL_REPLY_TO_ADDRESS || env.EMAIL_REPLY_TO_NAME
			? {
					replyTo: {
						address: env.EMAIL_REPLY_TO_ADDRESS ?? "",
						...(env.EMAIL_REPLY_TO_NAME
							? { name: env.EMAIL_REPLY_TO_NAME }
							: {}),
					},
				}
			: {}),
		maxRecipients: Number(env.EMAIL_MAX_RECIPIENTS || 50),
	});
}
