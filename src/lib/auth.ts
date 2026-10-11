import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { magicLink } from "better-auth/plugins/magic-link";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { count } from "drizzle-orm";
import { db } from "#/db";
import * as schema from "#/db/schema";
import { env } from "#/env";
import { isInvitedEmail } from "#/features/sharing/invites.server";
import { resolveEmailConfig } from "#/integrations/email/config.server";
import { renderMagicLinkEmail } from "#/integrations/email/magic-link.server";
import { getApplicationEmail } from "./email.server";

const plugins = [] as ReturnType<
	| typeof apiKey
	| typeof genericOAuth
	| typeof magicLink
	| typeof tanstackStartCookies
>[];

plugins.push(
	apiKey({
		apiKeyHeaders: "x-api-key",
		defaultKeyLength: 64,
		defaultPrefix: "app_",
		disableKeyHashing: false,
		enableSessionForAPIKeys: false,
		keyExpiration: { defaultExpiresIn: null },
		references: "user",
		requireName: true,
		startingCharactersConfig: { shouldStore: true, charactersLength: 8 },
		permissions: {
			defaultPermissions: { captures: ["write"], orders: ["read"] },
		},
		rateLimit: {
			enabled: true,
			timeWindow: 60 * 1000,
			maxRequests: 1_000,
		},
	}),
);

if (env.OIDC_DISCOVERY_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
	plugins.push(
		genericOAuth({
			config: [
				{
					providerId: "oidc",
					name: "OpenID Connect",
					discoveryUrl: env.OIDC_DISCOVERY_URL,
					clientId: env.OIDC_CLIENT_ID,
					clientSecret: env.OIDC_CLIENT_SECRET,
					scopes: ["openid", "profile", "email"],
					pkce: true,
					requireIdTokenVerification: true,
				},
			],
		}),
	);
}

if (env.MAGIC_LINK_ENABLED === "true") {
	// Validate structure before exposing the flow; never contact SMTP at startup.
	resolveEmailConfig();
	plugins.push(
		magicLink({
			storeToken: "hashed",
			async sendMagicLink({ email, url }) {
				try {
					const content = renderMagicLinkEmail({
						appName: env.APP_NAME,
						url,
						appBaseUrl: env.APP_BASE_URL,
					});
					const result = await getApplicationEmail().sendEmail({
						to: [{ address: email }],
						...content,
					});
					if (result.outcome !== "accepted")
						throw new Error("Delivery incomplete");
				} catch {
					throw new APIError("SERVICE_UNAVAILABLE", {
						message: "Email delivery unavailable. Please try again later.",
					});
				}
			},
		}),
	);
}
plugins.push(tanstackStartCookies());

export const auth = betterAuth({
	appName: env.APP_NAME,
	baseURL: env.APP_BASE_URL,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: "pg" }),
	emailAndPassword: { enabled: false },
	socialProviders:
		env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
			? {
					github: {
						clientId: env.GITHUB_CLIENT_ID,
						clientSecret: env.GITHUB_CLIENT_SECRET,
					},
				}
			: {},
	account: {
		accountLinking: { enabled: true },
	},
	// Follow the public URL protocol so plain-HTTP LAN deployments can sign in.
	advanced: { useSecureCookies: env.APP_BASE_URL.startsWith("https://") },
	plugins,
	logger: { disabled: true },
	user: { deleteUser: { enabled: false } },
	databaseHooks: {
		user: {
			create: {
				// Personal ledger: sign-up is closed. ALLOWED_SIGNUP_EMAILS lists who
				// may create an account; when unset only the very first user may.
				before: async (candidate) => {
					const email = candidate.email.trim().toLowerCase();
					// Bookkeepers invited to view an entity may create an account.
					if (await isInvitedEmail(email)) return;
					const allowed = (env.ALLOWED_SIGNUP_EMAILS ?? "")
						.split(",")
						.map((value) => value.trim().toLowerCase())
						.filter(Boolean);
					if (allowed.length > 0) {
						// Entries are full addresses or whole domains ("@example.com").
						const domain = email.slice(email.lastIndexOf("@"));
						if (!allowed.includes(email) && !allowed.includes(domain))
							throw new APIError("FORBIDDEN", {
								message: "Sign-up is closed.",
							});
						return;
					}
					const [existing] = await db.select({ n: count() }).from(schema.user);
					if ((existing?.n ?? 0) > 0)
						throw new APIError("FORBIDDEN", { message: "Sign-up is closed." });
				},
			},
		},
	},
});
