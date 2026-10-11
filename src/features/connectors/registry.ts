/**
 * Connector provider registry. Server-only (providers are *.server.ts).
 */
import { customHttpProvider } from "./custom-http.server";
import { invoiceNinjaProvider } from "./invoice-ninja.server";
import {
	type ConnectorContext,
	ConnectorError,
	type ConnectorProvider,
	type ConnectorProviderId,
} from "./types";

// Method-syntax members make concrete providers assignable here.
export type AnyConnectorProvider = ConnectorProvider<unknown, unknown>;

const PROVIDERS = {
	custom_http: customHttpProvider,
	invoice_ninja: invoiceNinjaProvider,
} satisfies Record<ConnectorProviderId, AnyConnectorProvider>;

export function getProvider(id: ConnectorProviderId): AnyConnectorProvider;
export function getProvider(id: string): AnyConnectorProvider | undefined;
export function getProvider(id: string): AnyConnectorProvider | undefined {
	return Object.hasOwn(PROVIDERS, id)
		? (PROVIDERS[id as ConnectorProviderId] as AnyConnectorProvider)
		: undefined;
}

export function listProviders(): AnyConnectorProvider[] {
	return Object.values(PROVIDERS) as AnyConnectorProvider[];
}

/**
 * Validate stored config + decrypted secret into a provider context.
 * Throws ConnectorError("validation") with field paths on bad settings.
 */
export function buildContext(
	provider: AnyConnectorProvider,
	rawConfig: unknown,
	rawSecret: unknown,
	extra: Pick<ConnectorContext<unknown, unknown>, "fetch" | "signal"> = {},
): ConnectorContext<unknown, unknown> {
	const config = provider.configSchema.safeParse(rawConfig);
	if (!config.success) {
		throw new ConnectorError(
			"validation",
			`Invalid ${provider.label} settings: ${formatIssues(config.error.issues)}`,
		);
	}
	const secret = provider.secretSchema.safeParse(rawSecret);
	if (!secret.success) {
		// Never echo secret values; paths + messages only.
		throw new ConnectorError(
			"validation",
			`Invalid ${provider.label} credentials: ${formatIssues(secret.error.issues)}`,
		);
	}
	return { config: config.data, secret: secret.data, ...extra };
}

function formatIssues(
	issues: Array<{ path: PropertyKey[]; message: string }>,
): string {
	return issues
		.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
		.join("; ");
}
