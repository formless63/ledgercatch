import { createServerFn } from "@tanstack/react-start";

export type AuthProviders = {
	github: boolean;
	oidc: boolean;
	magicLink: boolean;
};

/** Which sign-in methods the server has configured (booleans only, no secrets). */
export const getAuthProviders = createServerFn({ method: "GET" }).handler(
	async (): Promise<AuthProviders> => {
		const { env } = await import("#/env");
		return {
			github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
			oidc: Boolean(
				env.OIDC_DISCOVERY_URL && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET,
			),
			magicLink: env.MAGIC_LINK_ENABLED === "true",
		};
	},
);
