/**
 * Application composition of the Invoice Ninja capability for reimbursement
 * invoices. Connections are the owner's existing `connections` rows with
 * provider `invoice_ninja` (capability connection id `c-<uuid>`); the draft
 * policy and webhook secret come from `invoice_ninja_claim_settings`.
 * See docs/AUTOMATION.md for the policy an operator must verify.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";
import { invoiceNinjaClaimSettings } from "../features/automation/schema";
import { decryptSecret } from "../features/connectors/crypto.server";
import { connections } from "../features/ledger/schema";
import { InvoiceNinjaError } from "../integrations/invoice-ninja/errors";
import { createInvoiceNinjaJobs } from "../integrations/invoice-ninja/jobs.server";
import type {
	Binding,
	DraftPolicy,
} from "../integrations/invoice-ninja/schema";
import {
	createInvoiceNinja,
	type Database,
} from "../integrations/invoice-ninja/service.server";
import {
	environmentConnection,
	providerPin,
} from "../integrations/invoice-ninja/transport.server";

const PREFIX = "c-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Capability connection id for one of our `connections` rows. */
export function invoiceNinjaConnectionRef(connectionId: string) {
	return `${PREFIX}${connectionId}`;
}
export function parseInvoiceNinjaConnectionRef(ref: string) {
	const id = ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : "";
	return UUID.test(id) ? id : null;
}

async function loadConnection(ref: string) {
	const id = parseInvoiceNinjaConnectionRef(ref);
	if (!id) return null;
	const [row] = await db
		.select({
			connection: connections,
			settings: invoiceNinjaClaimSettings,
		})
		.from(connections)
		.leftJoin(
			invoiceNinjaClaimSettings,
			eq(invoiceNinjaClaimSettings.connectionId, connections.id),
		)
		.where(
			and(eq(connections.id, id), eq(connections.provider, "invoice_ninja")),
		)
		.limit(1);
	return row ?? null;
}

// Projection currency is resolved synchronously by the capability; it is the
// verified policy currency of the binding's connection, cached when the
// connection is resolved (always before any projection is written).
const policyCurrency = new Map<string, string>();

const existingOwner = async (id: string) =>
	!!(await db.select({ id: user.id }).from(user).where(eq(user.id, id)))[0];
async function connectionOwnedBy(ref: string, ownerId: string) {
	if (ref === "default") return true;
	const row = await loadConnection(ref);
	return row?.connection.ownerId === ownerId;
}

export const applicationInvoiceNinja = createInvoiceNinja({
	database: db,
	authorizeScope: async (actor, scope, signal) => {
		signal.throwIfAborted();
		return (
			scope.kind === "user" &&
			scope.id === actor &&
			(await existingOwner(actor))
		);
	},
	authorizeBoundResource: async (ctx, binding, signal) => {
		signal.throwIfAborted();
		return (
			ctx.scope.kind === "user" &&
			binding.scopeKind === "user" &&
			binding.scopeId === ctx.actorUserId &&
			(await existingOwner(ctx.actorUserId)) &&
			(await connectionOwnedBy(binding.connectionId, ctx.actorUserId))
		);
	},
	authorizeReconciliation: async (binding, signal) => {
		signal.throwIfAborted();
		return (
			binding.scopeKind === "user" &&
			binding.retiredAt === null &&
			(await existingOwner(binding.scopeId)) &&
			(await connectionOwnedBy(binding.connectionId, binding.scopeId))
		);
	},
	resolveConnection: async (ref) => {
		if (ref === "default") return environmentConnection();
		const row = await loadConnection(ref);
		if (!row?.connection.enabled || !row.connection.secretCiphertext)
			throw new InvoiceNinjaError("unconfigured");
		const config = row.connection.config as { baseUrl?: unknown };
		const secret = decryptSecret<{ apiToken?: unknown }>(
			row.connection.secretCiphertext,
		);
		if (row.settings?.policy?.currency)
			policyCurrency.set(ref, row.settings.policy.currency);
		return {
			baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : "",
			apiToken: typeof secret.apiToken === "string" ? secret.apiToken : "",
		};
	},
	webhookSecrets: async (ref) => {
		if (ref === "default")
			return {
				current: process.env.INVOICE_NINJA_WEBHOOK_SECRET ?? "",
				previous: process.env.INVOICE_NINJA_WEBHOOK_SECRET_PREVIOUS,
			};
		const row = await loadConnection(ref);
		const ciphertext = row?.settings?.webhookSecretCiphertext;
		if (!ciphertext) throw new InvoiceNinjaError("unconfigured");
		return { current: decryptSecret<string>(ciphertext) };
	},
	// Missing or unverified policy denies drafts (capability default).
	resolveDraftPolicy: async (ctx, binding: Binding, signal) => {
		signal.throwIfAborted();
		const row = await loadConnection(binding.connectionId);
		const policy = row?.settings?.policy;
		if (!row || row.connection.ownerId !== ctx.actorUserId || !policy)
			throw new InvoiceNinjaError("unsupported");
		return {
			currencyId: policy.currencyId,
			currency: policy.currency,
			configurationIdentity: policy.configurationIdentity,
			verifiedPin: providerPin.commit,
			numericStrings: true,
			unsent: true,
			zeroTax: true,
			zeroDiscount: true,
		} satisfies DraftPolicy;
	},
	resolveCurrency: (binding) =>
		policyCurrency.get(binding.connectionId) ?? null,
	enqueue: async (tx: Database, kind, id) => {
		const { sendJobInTransaction } = await import(
			"../integrations/jobs/client.server"
		);
		type Tx = Parameters<typeof sendJobInTransaction>[0];
		return kind === "operation"
			? sendJobInTransaction(tx as Tx, "invoice-ninja.operation", {
					operationId: id,
				})
			: sendJobInTransaction(tx as Tx, "invoice-ninja.receipt", {
					inboxId: id,
				});
	},
});
export const applicationInvoiceNinjaJobs = createInvoiceNinjaJobs(
	applicationInvoiceNinja,
);
