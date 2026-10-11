import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const DEVELOPMENT_DATABASE_URL =
	"postgresql://starter:starter@localhost:5432/starter";
const DEVELOPMENT_AUTH_SECRET = "development-only-secret-change-me-now";
const DEVELOPMENT_APP_URL = "http://localhost:3000";

const optionalUrl = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.url().optional(),
);
const optionalString = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.string().min(1).optional(),
);

export function serverSchemaFor(nodeEnv: string | undefined) {
	const production = nodeEnv === "production";
	return {
		DATABASE_URL: production
			? z
					.string()
					.url("DATABASE_URL must be an explicit PostgreSQL URL in production")
					.refine((value) => value !== DEVELOPMENT_DATABASE_URL, {
						message: "DATABASE_URL must not use the development default",
					})
			: z.string().url().default(DEVELOPMENT_DATABASE_URL),
		BETTER_AUTH_SECRET: production
			? z
					.string()
					.min(32, "BETTER_AUTH_SECRET must contain at least 32 characters")
					.refine((value) => value !== DEVELOPMENT_AUTH_SECRET, {
						message: "BETTER_AUTH_SECRET must not use the development default",
					})
			: z.string().min(32).default(DEVELOPMENT_AUTH_SECRET),
		APP_BASE_URL: production
			? z
					.url("APP_BASE_URL must be an explicit URL in production")
					.refine((value) => !value.includes("localhost"), {
						message: "APP_BASE_URL must not use localhost in production",
					})
			: z.url().default(DEVELOPMENT_APP_URL),
		/** Connector secret encryption key; falls back to BETTER_AUTH_SECRET. */
		APP_ENCRYPTION_KEY: z.preprocess(
			(value) => (value === "" ? undefined : value),
			z
				.string()
				.min(32, "APP_ENCRYPTION_KEY must contain at least 32 characters")
				.optional(),
		),
		GITHUB_CLIENT_ID: optionalString,
		GITHUB_CLIENT_SECRET: optionalString,
		OIDC_DISCOVERY_URL: optionalUrl,
		OIDC_CLIENT_ID: optionalString,
		OIDC_CLIENT_SECRET: optionalString,
		APP_NAME: z.string().min(1).default("LedgerCatch"),
		ALLOWED_SIGNUP_EMAILS: z.string().max(4000).optional(),
		MAGIC_LINK_ENABLED: z.enum(["true", "false"]).default("false"),
		NODE_ENV: z
			.enum(["development", "test", "production"])
			.default("development"),
	};
}

const runtimeEnv = { ...import.meta.env, ...process.env };

export const env = createEnv({
	server: serverSchemaFor(runtimeEnv.NODE_ENV),
	clientPrefix: "VITE_",
	client: { VITE_APP_NAME: z.string().min(1).default("LedgerCatch") },
	runtimeEnv,
	emptyStringAsUndefined: true,
});
