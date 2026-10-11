/**
 * Reimbursement invoices through the Invoice Ninja capability: map owing
 * entities to Invoice Ninja clients (capability client bindings), request an
 * UNSENT draft invoice per submitted claim, and mark the claim paid when the
 * capability's projection reports the invoice paid.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, like } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import {
	decryptSecret,
	encryptSecret,
} from "#/features/connectors/crypto.server";
import { minorToDecimalString } from "#/features/connectors/types";
import { claims, connections, entities } from "#/features/ledger/schema";
import { InvoiceNinjaError } from "#/integrations/invoice-ninja/errors";
import {
	bindings,
	invoices,
	operations,
} from "#/integrations/invoice-ninja/schema";
import type { TrustedContext } from "#/integrations/invoice-ninja/validation";
import {
	applicationInvoiceNinja,
	invoiceNinjaConnectionRef,
} from "#/lib/invoice-ninja.server";
import { claimSettingsInput, clientMappingInput } from "./inputs";
import { notifyOwner } from "./notify.server";
import { invoiceNinjaClaimDrafts, invoiceNinjaClaimSettings } from "./schema";
import { buildClaimPayload } from "./webhook-events";
import { emitLedgerWebhook } from "./webhooks.server";

const ctxFor = (ownerId: string): TrustedContext => ({
	actorUserId: ownerId,
	scope: { kind: "user", id: ownerId },
});

export { claimSettingsInput, clientMappingInput };

async function ownedConnection(ownerId: string, connectionId: string) {
	const [row] = await db
		.select()
		.from(connections)
		.where(
			and(
				eq(connections.id, connectionId),
				eq(connections.ownerId, ownerId),
				eq(connections.provider, "invoice_ninja"),
			),
		);
	if (!row) throw new Error("Unknown Invoice Ninja connection");
	return row;
}

const clientPrefix = (connectionId: string, entityId: string) =>
	`${invoiceNinjaConnectionRef(connectionId)}:${entityId}:`;

async function activeClientBinding(
	ownerId: string,
	connectionId: string,
	entityId: string,
) {
	const [row] = await db
		.select()
		.from(bindings)
		.where(
			and(
				eq(bindings.scopeKind, "user"),
				eq(bindings.scopeId, ownerId),
				eq(bindings.resourceKind, "client"),
				eq(bindings.connectionId, invoiceNinjaConnectionRef(connectionId)),
				like(
					bindings.localResourceId,
					`${clientPrefix(connectionId, entityId)}%`,
				),
				isNull(bindings.retiredAt),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function getInvoiceNinjaSetupForOwner(ownerId: string) {
	const rows = await db
		.select({ connection: connections, settings: invoiceNinjaClaimSettings })
		.from(connections)
		.leftJoin(
			invoiceNinjaClaimSettings,
			eq(invoiceNinjaClaimSettings.connectionId, connections.id),
		)
		.where(
			and(
				eq(connections.ownerId, ownerId),
				eq(connections.provider, "invoice_ninja"),
			),
		);
	const clientBindings = await db
		.select()
		.from(bindings)
		.where(
			and(
				eq(bindings.scopeKind, "user"),
				eq(bindings.scopeId, ownerId),
				eq(bindings.resourceKind, "client"),
				isNull(bindings.retiredAt),
			),
		);
	const base = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
	const drafts = await recentDraftsForOwner(ownerId);
	return {
		connections: rows.map(({ connection, settings }) => {
			const ref = invoiceNinjaConnectionRef(connection.id);
			return {
				id: connection.id,
				name: connection.name,
				entityId: connection.entityId,
				enabled: connection.enabled,
				autoDraft: settings?.autoDraft ?? false,
				policy: settings?.policy ?? null,
				hasWebhookSecret: !!settings?.webhookSecretCiphertext,
				webhookUrl: `${base}/api/integrations/invoice-ninja/webhooks/${ref}/invoice-updated`,
				mappings: clientBindings
					.filter((b) => b.connectionId === ref)
					.map((b) => ({
						bindingId: b.id,
						entityId: b.localResourceId.split(":")[1] ?? "",
						remoteClientId: b.remoteId,
					})),
			};
		}),
		drafts,
	};
}

async function recentDraftsForOwner(ownerId: string) {
	const rows = await db
		.select({
			claimId: invoiceNinjaClaimDrafts.claimId,
			connectionId: invoiceNinjaClaimDrafts.connectionId,
			operationId: invoiceNinjaClaimDrafts.operationId,
			createdAt: invoiceNinjaClaimDrafts.createdAt,
			operationStatus: operations.status,
			operationError: operations.errorCode,
		})
		.from(invoiceNinjaClaimDrafts)
		.leftJoin(
			operations,
			eq(operations.id, invoiceNinjaClaimDrafts.operationId),
		)
		.where(eq(invoiceNinjaClaimDrafts.ownerId, ownerId))
		.orderBy(desc(invoiceNinjaClaimDrafts.createdAt))
		.limit(50);
	const out = [];
	for (const row of rows) {
		const [invoice] = await db
			.select({
				number: invoices.number,
				status: invoices.status,
				remoteId: bindings.remoteId,
			})
			.from(bindings)
			.innerJoin(invoices, eq(invoices.bindingId, bindings.id))
			.where(
				and(
					eq(bindings.resourceKind, "invoice"),
					eq(bindings.localResourceId, row.operationId),
				),
			)
			.limit(1);
		out.push({
			...row,
			createdAt: row.createdAt.toISOString(),
			invoiceNumber: invoice?.number ?? null,
			invoiceStatus: invoice?.status ?? null,
		});
	}
	return out;
}

export async function saveClaimSettingsForOwner(
	ownerId: string,
	input: z.output<typeof claimSettingsInput>,
) {
	await ownedConnection(ownerId, input.connectionId);
	const policy = input.policy
		? {
				currencyId: input.policy.currencyId,
				currency: input.policy.currency,
				configurationIdentity: input.policy.configurationIdentity,
				verifiedAt: new Date().toISOString(),
			}
		: null;
	await db
		.insert(invoiceNinjaClaimSettings)
		.values({
			connectionId: input.connectionId,
			ownerId,
			autoDraft: input.autoDraft,
			policy,
		})
		.onConflictDoUpdate({
			target: invoiceNinjaClaimSettings.connectionId,
			set: { autoDraft: input.autoDraft, policy, updatedAt: new Date() },
		});
	return { ok: true };
}

/** Generate a new inbound webhook secret; the plaintext is returned once. */
export async function rotateInvoiceNinjaWebhookSecretForOwner(
	ownerId: string,
	connectionId: string,
) {
	await ownedConnection(ownerId, connectionId);
	const secret = randomBytes(36).toString("base64url");
	await db
		.insert(invoiceNinjaClaimSettings)
		.values({
			connectionId,
			ownerId,
			webhookSecretCiphertext: encryptSecret(secret),
		})
		.onConflictDoUpdate({
			target: invoiceNinjaClaimSettings.connectionId,
			set: {
				webhookSecretCiphertext: encryptSecret(secret),
				updatedAt: new Date(),
			},
		});
	return { secret };
}

export async function revealInvoiceNinjaWebhookSecretForOwner(
	ownerId: string,
	connectionId: string,
) {
	await ownedConnection(ownerId, connectionId);
	const [row] = await db
		.select({ secret: invoiceNinjaClaimSettings.webhookSecretCiphertext })
		.from(invoiceNinjaClaimSettings)
		.where(eq(invoiceNinjaClaimSettings.connectionId, connectionId));
	if (!row?.secret) throw new Error("No webhook secret yet");
	return { secret: decryptSecret<string>(row.secret) };
}

/**
 * Bind an owing entity to an Invoice Ninja client. Bindings are retired, never
 * remapped (capability rule): a changed client retires the old binding first.
 */
export async function mapEntityClientForOwner(
	ownerId: string,
	input: z.output<typeof clientMappingInput>,
) {
	await ownedConnection(ownerId, input.connectionId);
	const [entity] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.id, input.entityId), eq(entities.ownerId, ownerId)));
	if (!entity) throw new Error("Unknown entity");
	const ctx = ctxFor(ownerId);
	const current = await activeClientBinding(
		ownerId,
		input.connectionId,
		input.entityId,
	);
	if (current && current.remoteId === input.remoteClientId) return { ok: true };
	try {
		await db.transaction(async (tx) => {
			if (current)
				await applicationInvoiceNinja.retireBinding(tx, ctx, {
					bindingId: current.id,
				});
			if (input.remoteClientId)
				await applicationInvoiceNinja.createBinding(tx, ctx, {
					localResourceId: `${clientPrefix(input.connectionId, input.entityId)}${Date.now().toString(36)}`,
					connectionId: invoiceNinjaConnectionRef(input.connectionId),
					resourceKind: "client",
					remoteId: input.remoteClientId,
				});
		});
	} catch (error) {
		if (error instanceof InvoiceNinjaError)
			throw new Error(
				error.code === "conflict"
					? "That Invoice Ninja client was mapped before; retired mappings cannot be reused."
					: error.code === "unconfigured"
						? "The connection is not usable (HTTPS base URL and API token required)."
						: `Invoice Ninja: ${error.code}`,
			);
		throw error;
	}
	return { ok: true };
}

/** Request an unsent draft invoice for one submitted claim (idempotent per claim). */
export async function requestClaimDraftForOwner(
	ownerId: string,
	claimId: string,
	connectionId?: string,
) {
	const [existing] = await db
		.select()
		.from(invoiceNinjaClaimDrafts)
		.where(
			and(
				eq(invoiceNinjaClaimDrafts.claimId, claimId),
				eq(invoiceNinjaClaimDrafts.ownerId, ownerId),
			),
		);
	if (existing) return { operationId: existing.operationId, existing: true };
	const { getClaimForOwner } = await import("#/features/ledger/ledger.server");
	const { claim, lines } = await getClaimForOwner(ownerId, claimId);
	if (claim.status !== "submitted")
		throw new Error("Only submitted claims can be invoiced");
	const candidates = await db
		.select({
			connectionId: invoiceNinjaClaimSettings.connectionId,
			policy: invoiceNinjaClaimSettings.policy,
		})
		.from(invoiceNinjaClaimSettings)
		.innerJoin(
			connections,
			eq(connections.id, invoiceNinjaClaimSettings.connectionId),
		)
		.where(
			and(
				eq(invoiceNinjaClaimSettings.ownerId, ownerId),
				eq(connections.enabled, true),
				connectionId
					? eq(invoiceNinjaClaimSettings.connectionId, connectionId)
					: undefined,
			),
		);
	let chosen: { connectionId: string; clientBindingId: string } | null = null;
	for (const candidate of candidates) {
		if (candidate.policy?.currency !== claim.currency) continue;
		const binding = await activeClientBinding(
			ownerId,
			candidate.connectionId,
			claim.owingEntityId,
		);
		if (binding) {
			chosen = {
				connectionId: candidate.connectionId,
				clientBindingId: binding.id,
			};
			break;
		}
	}
	if (!chosen)
		throw new Error(
			`No Invoice Ninja connection with a verified ${claim.currency} draft policy and a client mapped for the owing entity`,
		);
	const draftLines = lines.map((line) => ({
		description:
			`${line.merchantName || line.source} order ${line.externalOrderId}${line.orderDate ? ` (${line.orderDate})` : ""}`.slice(
				0,
				2000,
			),
		quantity: "1",
		unitCost: minorToDecimalString(line.amountMinor, claim.currency),
	}));
	if (draftLines.some((line) => line.unitCost.startsWith("-")))
		throw new Error("Claims with negative lines cannot be invoiced");
	const finalLines =
		draftLines.length <= 100
			? draftLines
			: [
					{
						description: `Reimbursement of ${draftLines.length} orders (claim ${claim.id.slice(0, 8)})`,
						quantity: "1",
						unitCost: minorToDecimalString(claim.totalMinor, claim.currency),
					},
				];
	const ctx = ctxFor(ownerId);
	const target = chosen;
	try {
		const operation = await db.transaction(async (tx) => {
			const op = await applicationInvoiceNinja.requestDraftInvoiceInTransaction(
				tx,
				ctx,
				{
					clientBindingId: target.clientBindingId,
					idempotencyKey: `claim-${claim.id}`,
					invoiceDate: new Date().toISOString().slice(0, 10),
					numbering: { mode: "provider" },
					lines: finalLines,
				},
			);
			await tx
				.insert(invoiceNinjaClaimDrafts)
				.values({
					claimId: claim.id,
					ownerId,
					connectionId: target.connectionId,
					operationId: "operationId" in op ? op.operationId : op.id,
				})
				.onConflictDoNothing();
			return op;
		});
		return {
			operationId:
				"operationId" in operation ? operation.operationId : operation.id,
			existing: false,
		};
	} catch (error) {
		if (error instanceof InvoiceNinjaError)
			throw new Error(`Invoice Ninja draft request failed: ${error.code}`);
		throw error;
	}
}

/**
 * Hook after claims are created/submitted: emits `claim.created` webhooks and,
 * where a connection has auto-draft on, requests the draft invoice.
 */
export async function afterClaimsCreated(ownerId: string, claimIds: string[]) {
	if (claimIds.length === 0) return { drafts: 0 };
	let drafts = 0;
	const auto = await db
		.select({ connectionId: invoiceNinjaClaimSettings.connectionId })
		.from(invoiceNinjaClaimSettings)
		.where(
			and(
				eq(invoiceNinjaClaimSettings.ownerId, ownerId),
				eq(invoiceNinjaClaimSettings.autoDraft, true),
			),
		);
	for (const claimId of claimIds) {
		const [claim] = await db
			.select()
			.from(claims)
			.where(and(eq(claims.id, claimId), eq(claims.ownerId, ownerId)));
		if (!claim) continue;
		await emitLedgerWebhook(
			ownerId,
			"claim.created",
			buildClaimPayload(claim, process.env.APP_BASE_URL),
		);
		if (claim.status !== "submitted" || auto.length === 0) continue;
		for (const { connectionId } of auto) {
			try {
				await requestClaimDraftForOwner(ownerId, claimId, connectionId);
				drafts += 1;
				break;
			} catch {
				/* Not configured for this claim on this connection; try the next. */
			}
		}
	}
	return { drafts };
}

/**
 * Mark claims paid whose draft invoice the capability projects as `paid`.
 * Called after Invoice Ninja receipt/operation jobs and from the hourly sweep.
 */
export async function syncPaidClaims() {
	const rows = await db
		.select({
			claimId: invoiceNinjaClaimDrafts.claimId,
			ownerId: invoiceNinjaClaimDrafts.ownerId,
			status: invoices.status,
		})
		.from(invoiceNinjaClaimDrafts)
		.innerJoin(
			bindings,
			and(
				eq(bindings.resourceKind, "invoice"),
				eq(bindings.localResourceId, invoiceNinjaClaimDrafts.operationId),
			),
		)
		.innerJoin(invoices, eq(invoices.bindingId, bindings.id))
		.where(
			and(
				isNull(invoiceNinjaClaimDrafts.paidSyncedAt),
				eq(invoices.status, "paid"),
			),
		)
		.limit(100);
	const { setClaimStatusForOwner } = await import(
		"#/features/ledger/ledger.server"
	);
	let paid = 0;
	for (const row of rows) {
		const [claim] = await db
			.select()
			.from(claims)
			.where(and(eq(claims.id, row.claimId), eq(claims.ownerId, row.ownerId)));
		await db
			.update(invoiceNinjaClaimDrafts)
			.set({ paidSyncedAt: new Date() })
			.where(eq(invoiceNinjaClaimDrafts.claimId, row.claimId));
		if (!claim || claim.status === "paid" || claim.status === "void") continue;
		await setClaimStatusForOwner(row.ownerId, { id: claim.id, status: "paid" });
		paid += 1;
		const [updated] = await db
			.select()
			.from(claims)
			.where(eq(claims.id, claim.id));
		if (updated)
			await emitLedgerWebhook(
				row.ownerId,
				"claim.paid",
				buildClaimPayload(updated, process.env.APP_BASE_URL),
			);
		await notifyOwner(row.ownerId, {
			alert: "claimPaid",
			type: "claim.paid",
			title: "Reimbursement paid",
			body: `Invoice Ninja reports the reimbursement invoice for claim ${claim.reference ?? claim.id.slice(0, 8)} as paid; the claim is now marked paid.`,
			link: "/app/reimbursements",
			metadata: { claimId: claim.id },
		}).catch(() => null);
	}
	return { paid };
}
