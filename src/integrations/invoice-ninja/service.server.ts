import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { type ErrorCode, InvoiceNinjaError } from "./errors";
import { entity, invoiceProjection, remoteId } from "./projection";
import {
	type Binding,
	bindings,
	clients,
	type DraftPolicy,
	type FrozenDraft,
	inbox,
	invoices,
	type OperationKind,
	operations,
} from "./schema";
import {
	type Connection,
	createProviderDraft,
	environmentConnection,
	providerRequest,
	validateConnection,
} from "./transport.server";
import {
	bindingRef,
	clientReconciliation,
	connectionId,
	decodeCursor,
	draftInput,
	encodeCursor,
	invoiceReconciliation,
	listInput,
	opaqueId,
	operationRef,
	parse,
	scopeSchema,
	type TrustedContext,
	uuid,
} from "./validation";
import { authenticateHint, eventKinds } from "./webhook.server";
export type Database = Pick<
	NodePgDatabase,
	"select" | "insert" | "update" | "delete" | "execute"
>;
export interface TransactionOwner {
	transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
export type Signal = AbortSignal;
export interface Wiring {
	database: Database & TransactionOwner;
	enqueue(
		tx: Database,
		kind: "operation" | "receipt",
		id: string,
	): Promise<unknown>;
	authorizeScope?(
		actorUserId: string,
		scope: TrustedContext["scope"],
		signal: Signal,
	): Promise<boolean>;
	authorizeBoundResource?(
		context: TrustedContext,
		binding: Binding,
		signal: Signal,
	): Promise<boolean>;
	authorizeReconciliation?(binding: Binding, signal: Signal): Promise<boolean>;
	resolveConnection?(id: string, signal: Signal): Promise<Connection>;
	resolveDraftPolicy?(
		context: TrustedContext,
		binding: Binding,
		signal: Signal,
	): Promise<DraftPolicy>;
	resolveCurrency?(
		binding: Binding,
		state: Readonly<Record<string, unknown>>,
	): string | null;
	webhookSecrets?(
		connectionId: string,
		signal: Signal,
	): Promise<{ current: string; previous?: string }>;
}
const policySchema = z.strictObject({
	currencyId: opaqueId,
	currency: z.string().regex(/^[A-Z]{3}$/),
	configurationIdentity: opaqueId,
	verifiedPin: z.literal("382020072bc79e8c7ede49f7e9ce91b0aeb1a051"),
	numericStrings: z.literal(true),
	unsent: z.literal(true),
	zeroTax: z.literal(true),
	zeroDiscount: z.literal(true),
});
type Operation = typeof operations.$inferSelect;
const failure = (error: unknown) =>
	error instanceof InvoiceNinjaError
		? error
		: new InvoiceNinjaError("unavailable");
function publicOperation(row: Operation) {
	const code = row.errorCode as ErrorCode | null;
	return {
		id: row.id,
		kind: row.kind,
		status: row.status,
		bindingId: row.bindingId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		error: code
			? new InvoiceNinjaError(code).public(row.kind !== "create_draft")
			: null,
	};
}
function invoiceView(b: Binding, p: typeof invoices.$inferSelect) {
	return {
		bindingId: b.id,
		remoteId: b.remoteId,
		number: p.number,
		status: p.status,
		currency: p.currency,
		amount: p.amount,
		balance: p.balance,
		sourceUpdatedAt: p.sourceUpdatedAt?.toISOString() ?? null,
		syncedAt: p.syncedAt.toISOString(),
		deleted: p.deleted,
	};
}
const active = (
	id: string,
	ctx?: TrustedContext,
	kind?: Binding["resourceKind"],
) =>
	and(
		eq(bindings.id, id),
		isNull(bindings.retiredAt),
		ctx
			? and(
					eq(bindings.scopeKind, ctx.scope.kind),
					eq(bindings.scopeId, ctx.scope.id),
				)
			: undefined,
		kind ? eq(bindings.resourceKind, kind) : undefined,
	);
export function createInvoiceNinja(w: Wiring) {
	const db = w.database;
	async function transaction<T>(
		work: (tx: Database) => Promise<T>,
	): Promise<T> {
		return db.transaction(async (tx) => {
			await tx.execute(
				sql`select set_config('transaction_timeout', '5000ms', true), set_config('statement_timeout', '4500ms', true), set_config('lock_timeout', '1000ms', true)`,
			);
			return work(tx);
		});
	}
	async function scope(ctx: TrustedContext, signal: Signal) {
		parse(opaqueId, ctx.actorUserId);
		parse(scopeSchema, ctx.scope);
		signal.throwIfAborted();
		if (ctx.scope.kind === "user" && ctx.scope.id !== ctx.actorUserId)
			throw new InvoiceNinjaError("forbidden");
		if (
			!w.authorizeScope ||
			!(await w.authorizeScope(ctx.actorUserId, ctx.scope, signal))
		)
			throw new InvoiceNinjaError("forbidden");
		signal.throwIfAborted();
	}
	async function bound(
		tx: Database,
		id: string,
		ctx?: TrustedContext,
		kind?: Binding["resourceKind"],
		signal: Signal = new AbortController().signal,
	) {
		const [b] = await tx
			.select()
			.from(bindings)
			.where(active(id, ctx, kind));
		if (!b) throw new InvoiceNinjaError("not_found");
		if (ctx) {
			await scope(ctx, signal);
			if (
				!w.authorizeBoundResource ||
				!(await w.authorizeBoundResource(ctx, b, signal))
			)
				throw new InvoiceNinjaError("not_found");
		} else if (
			!w.authorizeReconciliation ||
			!(await w.authorizeReconciliation(b, signal))
		)
			throw new InvoiceNinjaError("forbidden");
		signal.throwIfAborted();
		return b;
	}
	async function connection(id: string, signal: Signal) {
		parse(connectionId, id);
		signal.throwIfAborted();
		const c = w.resolveConnection
			? await w.resolveConnection(id, signal)
			: id === "default"
				? environmentConnection()
				: null;
		if (!c) throw new InvoiceNinjaError("unconfigured");
		signal.throwIfAborted();
		return validateConnection(c);
	}
	function workerSignal(signal?: Signal) {
		const deadline = AbortSignal.timeout(45000);
		return signal ? AbortSignal.any([signal, deadline]) : deadline;
	}
	/** Trusted server extension only; caller supplies the transaction. Never creates/remaps bindings from callback metadata. */
	async function createBinding(
		tx: Database,
		ctx: TrustedContext,
		input: unknown,
	) {
		const data = parse(
			z.strictObject({
				localResourceId: opaqueId,
				connectionId: connectionId,
				resourceKind: z.enum(["client", "invoice"]),
				remoteId: opaqueId,
			}),
			input,
		);
		const signal = workerSignal(ctx.signal);
		await scope(ctx, signal);
		await connection(data.connectionId, signal);
		const b: Binding = {
			...data,
			id: randomUUID(),
			scopeKind: ctx.scope.kind,
			scopeId: ctx.scope.id,
			createdAt: new Date(),
			retiredAt: null,
			revision: 0,
			leaseToken: null,
			leaseUntil: null,
		};
		if (
			!w.authorizeBoundResource ||
			!(await w.authorizeBoundResource(ctx, b, signal))
		)
			throw new InvoiceNinjaError("forbidden");
		try {
			await tx.insert(bindings).values(b);
			return b.id;
		} catch {
			throw new InvoiceNinjaError("conflict");
		}
	}
	async function retireBinding(
		tx: Database,
		ctx: TrustedContext,
		input: unknown,
	) {
		const { bindingId } = parse(bindingRef, input);
		const b = await bound(tx, bindingId, ctx);
		await tx
			.update(bindings)
			.set({
				retiredAt: new Date(),
				revision: sql`${bindings.revision}+1`,
				leaseToken: null,
				leaseUntil: null,
			})
			.where(eq(bindings.id, b.id));
	}
	async function getClient(ctx: TrustedContext, input: unknown) {
		const { bindingId } = parse(bindingRef, input);
		const b = await bound(
			db,
			bindingId,
			ctx,
			"client",
			workerSignal(ctx.signal),
		);
		const [p] = await db
			.select()
			.from(clients)
			.where(eq(clients.bindingId, b.id));
		if (!p) throw new InvoiceNinjaError("not_found");
		return {
			bindingId: b.id,
			remoteId: b.remoteId,
			syncedAt: p.syncedAt.toISOString(),
		};
	}
	async function getInvoice(ctx: TrustedContext, input: unknown) {
		const { bindingId } = parse(bindingRef, input);
		const b = await bound(
			db,
			bindingId,
			ctx,
			"invoice",
			workerSignal(ctx.signal),
		);
		const [p] = await db
			.select()
			.from(invoices)
			.where(eq(invoices.bindingId, b.id));
		if (!p) throw new InvoiceNinjaError("not_found");
		return invoiceView(b, p);
	}
	async function getOperation(ctx: TrustedContext, input: unknown) {
		const { operationId } = parse(operationRef, input);
		await scope(ctx, workerSignal(ctx.signal));
		const [row] = await db
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.id, operationId),
					eq(operations.scopeKind, ctx.scope.kind),
					eq(operations.scopeId, ctx.scope.id),
				),
			);
		if (!row) throw new InvoiceNinjaError("not_found");
		return publicOperation(row);
	}
	async function listInvoices(ctx: TrustedContext, input: unknown = {}) {
		const data = parse(listInput, input);
		const signal = workerSignal(ctx.signal);
		await scope(ctx, signal);
		const cursor = data.cursor ? decodeCursor(data.cursor) : null;
		const rows = await db
			.select({ b: bindings, p: invoices })
			.from(bindings)
			.innerJoin(invoices, eq(invoices.bindingId, bindings.id))
			.where(
				and(
					isNull(bindings.retiredAt),
					eq(bindings.resourceKind, "invoice"),
					eq(bindings.scopeKind, ctx.scope.kind),
					eq(bindings.scopeId, ctx.scope.id),
					cursor
						? sql`(${bindings.createdAt},${bindings.id}) < (${cursor[0]}::timestamptz,${cursor[1]}::uuid)`
						: undefined,
				),
			)
			.orderBy(desc(bindings.createdAt), desc(bindings.id))
			.limit(data.limit + 1);
		// SQL scope is mandatory; current application resource policy is also rechecked on every returned row.
		const result = [];
		for (const row of rows.slice(0, data.limit)) {
			await bound(db, row.b.id, ctx, "invoice", signal);
			result.push(invoiceView(row.b, row.p));
		}
		const last = rows[Math.min(data.limit, rows.length) - 1];
		return {
			items: result,
			nextCursor:
				rows.length > data.limit && last
					? encodeCursor(last.b.createdAt, last.b.id)
					: null,
		};
	}
	async function insertOperation(
		tx: Database,
		ctx: TrustedContext,
		b: Binding,
		kind: OperationKind,
		key: string,
		intent: FrozenDraft | null,
	) {
		const digest = createHash("sha256")
			.update(JSON.stringify(intent ? intent.input : { bindingId: b.id, kind }))
			.digest("hex");
		const now = new Date();
		const id = randomUUID();
		const values = {
			id,
			scopeKind: ctx.scope.kind,
			scopeId: ctx.scope.id,
			actorUserId: ctx.actorUserId,
			connectionId: b.connectionId,
			kind,
			status: "queued" as const,
			bindingId: b.id,
			callerKey: key,
			digest,
			intent,
			createdAt: now,
			updatedAt: now,
		};
		const inserted = await tx
			.insert(operations)
			.values(values)
			.onConflictDoNothing()
			.returning();
		if (inserted[0]) {
			await w.enqueue(tx, "operation", id);
			return { operationId: id, status: "queued" as const };
		}
		const [existing] = await tx
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.scopeKind, ctx.scope.kind),
					eq(operations.scopeId, ctx.scope.id),
					eq(operations.connectionId, b.connectionId),
					eq(operations.kind, kind),
					eq(operations.callerKey, key),
				),
			);
		if (!existing || existing.digest !== digest)
			throw new InvoiceNinjaError("conflict");
		return publicOperation(existing);
	}
	/** Caller-owned transaction: no commit, rollback, reconnect or provider HTTP. */
	async function requestReconciliationInTransaction(
		tx: Database,
		ctx: TrustedContext,
		input: unknown,
		kind: "client" | "invoice",
	) {
		const data =
			kind === "client"
				? parse(clientReconciliation, input)
				: parse(invoiceReconciliation, input);
		const id =
			"clientBindingId" in data ? data.clientBindingId : data.invoiceBindingId;
		const signal = workerSignal(ctx.signal);
		const current = await bound(tx, id, ctx, kind, signal);
		await connection(current.connectionId, signal);
		return insertOperation(
			tx,
			ctx,
			current,
			kind === "client" ? "reconcile_client" : "reconcile_invoice",
			randomUUID(),
			null,
		);
	}
	/** Convenience commands own one short local transaction. */
	async function requestReconciliation(
		ctx: TrustedContext,
		input: unknown,
		kind: "client" | "invoice",
	) {
		return transaction((tx) =>
			requestReconciliationInTransaction(tx, ctx, input, kind),
		);
	}
	async function requestDraftInvoiceInTransaction(
		tx: Database,
		ctx: TrustedContext,
		input: unknown,
	) {
		const data = parse(draftInput, input);
		const signal = workerSignal(ctx.signal);
		const b = await bound(tx, data.clientBindingId, ctx, "client", signal);
		await connection(b.connectionId, signal);
		// Same-input duplicates do not refreeze policy or return a false queued claim.
		const digest = createHash("sha256")
			.update(JSON.stringify(data))
			.digest("hex");
		const [prior] = await tx
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.scopeKind, ctx.scope.kind),
					eq(operations.scopeId, ctx.scope.id),
					eq(operations.connectionId, b.connectionId),
					eq(operations.kind, "create_draft"),
					eq(operations.callerKey, data.idempotencyKey),
				),
			);
		if (prior) {
			if (prior.digest !== digest) throw new InvoiceNinjaError("conflict");
			return publicOperation(prior);
		}
		if (!w.resolveDraftPolicy) throw new InvoiceNinjaError("unsupported");
		const policy = parse(
			policySchema,
			await w.resolveDraftPolicy(ctx, b, signal),
		);
		signal.throwIfAborted();
		const current = await bound(tx, b.id, ctx, "client", signal);
		return insertOperation(
			tx,
			ctx,
			current,
			"create_draft",
			data.idempotencyKey,
			{ input: data, policy, clientRemoteId: current.remoteId },
		);
	}
	async function requestDraftInvoice(ctx: TrustedContext, input: unknown) {
		return transaction((tx) =>
			requestDraftInvoiceInTransaction(tx, ctx, input),
		);
	}
	async function cancelOperation(ctx: TrustedContext, input: unknown) {
		const { operationId } = parse(operationRef, input);
		await scope(ctx, workerSignal(ctx.signal));
		const [row] = await db
			.update(operations)
			.set({
				status: "cancelled",
				updatedAt: new Date(),
				errorCode: "cancelled",
				revision: sql`${operations.revision}+1`,
			})
			.where(
				and(
					eq(operations.id, operationId),
					eq(operations.scopeKind, ctx.scope.kind),
					eq(operations.scopeId, ctx.scope.id),
					eq(operations.status, "queued"),
				),
			)
			.returning();
		return row ? publicOperation(row) : getOperation(ctx, { operationId });
	}
	async function claimBinding(tx: Database, b: Binding, token: string) {
		const now = new Date();
		const [claimed] = await tx
			.update(bindings)
			.set({
				leaseToken: token,
				leaseUntil: new Date(now.getTime() + 45000),
				revision: sql`${bindings.revision}+1`,
			})
			.where(
				and(
					eq(bindings.id, b.id),
					isNull(bindings.retiredAt),
					or(isNull(bindings.leaseUntil), lt(bindings.leaseUntil, now)),
				),
			)
			.returning();
		if (!claimed) throw new InvoiceNinjaError("unavailable");
		return claimed;
	}
	async function releaseBinding(
		tx: Database,
		bindingId: string,
		token: string,
	) {
		await tx
			.update(bindings)
			.set({ leaseToken: null, leaseUntil: null })
			.where(and(eq(bindings.id, bindingId), eq(bindings.leaseToken, token)));
	}
	async function saveProjection(
		tx: Database,
		b: Binding,
		token: string,
		state: Record<string, unknown> | null,
		ctx: TrustedContext | undefined,
		signal: Signal,
	) {
		await tx
			.select({ id: bindings.id })
			.from(bindings)
			.where(eq(bindings.id, b.id))
			.for("update");
		const current = await bound(tx, b.id, ctx, b.resourceKind, signal);
		if (
			current.leaseToken !== token ||
			!current.leaseUntil ||
			current.leaseUntil.getTime() <= Date.now()
		)
			throw new InvoiceNinjaError("conflict");
		if (state && remoteId(state.id) !== current.remoteId)
			throw new InvoiceNinjaError("unsupported");
		if (current.resourceKind === "client") {
			if (!state) throw new InvoiceNinjaError("not_found");
			await tx
				.insert(clients)
				.values({ bindingId: current.id, syncedAt: new Date() })
				.onConflictDoUpdate({
					target: clients.bindingId,
					set: { syncedAt: new Date() },
				});
			return false;
		}
		if (!state) {
			const existing = await tx
				.select()
				.from(invoices)
				.where(eq(invoices.bindingId, current.id));
			if (existing[0])
				await tx
					.update(invoices)
					.set({ status: "deleted", deleted: true, syncedAt: new Date() })
					.where(eq(invoices.bindingId, current.id));
			else
				await tx.insert(invoices).values({
					bindingId: current.id,
					status: "deleted",
					deleted: true,
					syncedAt: new Date(),
				});
			return false;
		}
		const projection = invoiceProjection(
			state,
			() => w.resolveCurrency?.(current, state) ?? null,
		);
		const { remoteId: _private, ...p } = projection;
		await tx
			.insert(invoices)
			.values({ bindingId: current.id, ...p })
			.onConflictDoUpdate({ target: invoices.bindingId, set: p });
		return projection.currency === null;
	}
	async function fetchState(b: Binding, signal: Signal) {
		const c = await connection(b.connectionId, signal);
		const response = await providerRequest(c, b.resourceKind, b.remoteId, {
			signal,
		});
		if (response.status === 404) return null;
		if (response.status === 429 || response.status >= 500)
			throw new InvoiceNinjaError("unavailable");
		if (response.status !== 200) throw new InvoiceNinjaError("unsupported");
		return entity(response.body);
	}
	async function runOperation(
		operationId: string,
		signalInput?: Signal,
		terminal = true,
	) {
		parse(uuid, operationId);
		const signal = workerSignal(signalInput);
		const token = randomUUID();
		let row: Operation | undefined;
		let b: Binding | undefined;
		let dispatched = false;
		let attemptClaimed = false;
		try {
			const [initial] = await db
				.select()
				.from(operations)
				.where(eq(operations.id, operationId));
			if (!initial || initial.status !== "queued")
				return { status: "ignored" as const };
			row = initial;
			const ctx: TrustedContext = {
				actorUserId: initial.actorUserId,
				scope: { kind: initial.scopeKind, id: initial.scopeId },
				signal,
			};
			b = await bound(
				db,
				initial.bindingId ?? "",
				ctx,
				initial.kind === "reconcile_invoice" ? "invoice" : "client",
				signal,
			);
			const c = await connection(b.connectionId, signal);
			if (initial.kind === "create_draft") {
				if (!initial.intent || !w.resolveDraftPolicy)
					throw new InvoiceNinjaError("unsupported");
				const policy = parse(
					policySchema,
					await w.resolveDraftPolicy(ctx, b, signal),
				);
				if (
					JSON.stringify(policy) !==
						JSON.stringify(parse(policySchema, initial.intent.policy)) ||
					initial.intent.clientRemoteId !== b.remoteId
				)
					throw new InvoiceNinjaError("conflict");
			}
			await transaction(async (tx) => {
				b = await bound(
					tx,
					initial.bindingId ?? "",
					ctx,
					b?.resourceKind,
					signal,
				);
				await claimBinding(tx, b, token);
				const [claimed] = await tx
					.update(operations)
					.set({
						status: "dispatching",
						leaseToken: token,
						leaseUntil: new Date(Date.now() + 45000),
						firstDispatchAt: initial.firstDispatchAt ?? new Date(),
						updatedAt: new Date(),
						revision: sql`${operations.revision}+1`,
					})
					.where(
						and(
							eq(operations.id, operationId),
							eq(operations.status, "queued"),
						),
					)
					.returning();
				if (!claimed) throw new InvoiceNinjaError("conflict");
				row = claimed;
			});
			attemptClaimed = true;
			if (!b || !row) throw new InvoiceNinjaError("unavailable");
			let state: Record<string, unknown> | null;
			if (row.kind === "create_draft") {
				dispatched = true;
				const response = await createProviderDraft(
					c,
					row.intent as FrozenDraft,
					{ signal },
				);
				if ([400, 401, 403, 404, 405, 409, 422].includes(response.status)) {
					dispatched = false; // Complete rejection proves no ambiguous acceptance.
					throw new InvoiceNinjaError("unsupported");
				}
				if (response.status < 200 || response.status >= 300)
					throw new InvoiceNinjaError("unavailable");
				state = entity(response.body);
				const id = remoteId(state.id);
				await db
					.update(operations)
					.set({ remoteId: id })
					.where(
						and(eq(operations.id, row.id), eq(operations.leaseToken, token)),
					);
				if (
					state.client_id !== b.remoteId ||
					state.status_id !== "1" ||
					state.last_sent_date !== ""
				)
					throw new InvoiceNinjaError("unsupported");
			} else state = await fetchState(b, signal);
			const parent = b;
			await transaction(async (tx) => {
				await tx
					.select({ id: bindings.id })
					.from(bindings)
					.where(eq(bindings.id, parent.id))
					.for("update");
				const current = await bound(
					tx,
					parent.id,
					ctx,
					parent.resourceKind,
					signal,
				);
				if (current.leaseToken !== token)
					throw new InvoiceNinjaError("conflict");
				let projectionBinding = current;
				if (row?.kind === "create_draft") {
					if (!state) throw new InvoiceNinjaError("unsupported");
					const childId = randomUUID();
					projectionBinding = {
						...current,
						id: childId,
						localResourceId: row.id,
						resourceKind: "invoice",
						remoteId: remoteId(state.id),
						createdAt: new Date(),
						revision: 1,
						leaseToken: token,
						leaseUntil: new Date(Date.now() + 45000),
					};
					await tx.insert(bindings).values(projectionBinding);
				}
				const unsupportedCurrency = await saveProjection(
					tx,
					projectionBinding,
					token,
					state,
					ctx,
					signal,
				);
				const [done] = await tx
					.update(operations)
					.set({
						status: unsupportedCurrency ? "failed" : "succeeded",
						bindingId: projectionBinding.id,
						errorCode: unsupportedCurrency ? "unsupported" : null,
						updatedAt: new Date(),
						leaseToken: null,
						leaseUntil: null,
						revision: sql`${operations.revision}+1`,
					})
					.where(
						and(
							eq(operations.id, operationId),
							eq(operations.status, "dispatching"),
							eq(operations.leaseToken, token),
						),
					)
					.returning();
				if (!done) throw new InvoiceNinjaError("conflict");
				await releaseBinding(tx, parent.id, token);
				if (projectionBinding.id !== parent.id)
					await releaseBinding(tx, projectionBinding.id, token);
			});
			return { status: "processed" as const };
		} catch (error) {
			const safe = failure(error);
			if (!row) return { status: "ignored" as const };
			const ambiguous = row.kind === "create_draft" && dispatched;
			const retry =
				!ambiguous &&
				row.kind !== "create_draft" &&
				!terminal &&
				["unavailable", "deadline_exceeded"].includes(safe.code);
			await transaction(async (tx) => {
				await tx
					.update(operations)
					.set({
						status: ambiguous
							? "reconciliation_required"
							: retry
								? "queued"
								: "failed",
						errorCode: safe.code,
						leaseToken: null,
						leaseUntil: null,
						updatedAt: new Date(),
						revision: sql`${operations.revision}+1`,
					})
					.where(
						and(
							eq(operations.id, operationId),
							attemptClaimed
								? and(
										eq(operations.status, "dispatching"),
										eq(operations.leaseToken, token),
									)
								: eq(operations.status, "queued"),
						),
					);
				if (b) await releaseBinding(tx, b.id, token);
			});
			if (retry) throw new InvoiceNinjaError(safe.code);
			return {
				status: ambiguous
					? ("reconciliation_required" as const)
					: ("processed" as const),
				errorCode: safe.code,
			};
		}
	}
	/** Caller-owned receipt transaction: authentication/body reading must have finished before calling this helper. */
	async function receiptInTransaction(
		tx: Database,
		connection: string,
		eventKind: string,
		hint: { bodySHA256: string; remoteId: string },
	) {
		parse(connectionId, connection);
		parse(opaqueId, hint.remoteId);
		if (!/^[0-9a-f]{64}$/.test(hint.bodySHA256))
			throw new InvoiceNinjaError("invalid_input");
		const supported = (eventKinds as readonly string[]).includes(eventKind);
		const kind = supported ? eventKind : "unsupported";
		const [b] = supported
			? await tx
					.select()
					.from(bindings)
					.where(
						and(
							eq(bindings.connectionId, connection),
							eq(bindings.resourceKind, "invoice"),
							eq(bindings.remoteId, hint.remoteId),
							isNull(bindings.retiredAt),
						),
					)
			: [];
		const id = randomUUID();
		const [inserted] = await tx
			.insert(inbox)
			.values({
				id,
				connectionId: connection,
				eventKind: kind,
				bodySHA256: hint.bodySHA256,
				remoteHint: hint.remoteId,
				bindingId: b?.id ?? null,
				state: b ? "received" : "ignored",
				receivedAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoNothing()
			.returning();
		if (inserted && b) await w.enqueue(tx, "receipt", id);
		return { accepted: true as const };
	}
	async function receive(
		request: Request,
		registeredConnection: string,
		eventKind: string,
	) {
		parse(connectionId, registeredConnection);
		const deadline = AbortSignal.timeout(5000);
		const signal = AbortSignal.any([deadline, request.signal]);
		const secrets = w.webhookSecrets
			? await w.webhookSecrets(registeredConnection, signal)
			: registeredConnection === "default"
				? {
						current: process.env.INVOICE_NINJA_WEBHOOK_SECRET ?? "",
						previous: process.env.INVOICE_NINJA_WEBHOOK_SECRET_PREVIOUS,
					}
				: null;
		if (!secrets) throw new InvoiceNinjaError("unconfigured");
		const hint = await authenticateHint(
			request,
			secrets.current,
			secrets.previous,
			{ signal },
		);
		try {
			return await transaction(async (tx) => {
				await tx.execute(sql`set local statement_timeout = '5s'`);
				signal.throwIfAborted();
				const result = await receiptInTransaction(
					tx,
					registeredConnection,
					eventKind,
					hint,
				);
				signal.throwIfAborted();
				return result;
			});
		} catch {
			throw new InvoiceNinjaError("unavailable");
		}
	}
	async function runReceipt(
		inboxId: string,
		signalInput?: Signal,
		terminal = true,
	) {
		parse(uuid, inboxId);
		const signal = workerSignal(signalInput);
		const token = randomUUID();
		let b: Binding | undefined;
		let claimed = false;
		try {
			const [row] = await db.select().from(inbox).where(eq(inbox.id, inboxId));
			if (!row || !["received", "failed"].includes(row.state) || !row.bindingId)
				return { status: "ignored" as const };
			b = await bound(db, row.bindingId, undefined, "invoice", signal);
			await connection(b.connectionId, signal);
			await transaction(async (tx) => {
				b = await bound(tx, row.bindingId ?? "", undefined, "invoice", signal);
				await claimBinding(tx, b, token);
				const [receipt] = await tx
					.update(inbox)
					.set({
						state: "processing",
						leaseToken: token,
						leaseUntil: new Date(Date.now() + 45000),
						updatedAt: new Date(),
						revision: sql`${inbox.revision}+1`,
					})
					.where(
						and(
							eq(inbox.id, inboxId),
							or(eq(inbox.state, "received"), eq(inbox.state, "failed")),
						),
					)
					.returning();
				if (!receipt) throw new InvoiceNinjaError("conflict");
			});
			claimed = true;
			if (!b) throw new InvoiceNinjaError("unavailable");
			const state = await fetchState(b, signal);
			const binding = b;
			await transaction(async (tx) => {
				const currencyUnsupported = await saveProjection(
					tx,
					binding,
					token,
					state,
					undefined,
					signal,
				);
				const [done] = await tx
					.update(inbox)
					.set({
						state: "processed",
						errorCode: currencyUnsupported ? "unsupported" : null,
						leaseToken: null,
						leaseUntil: null,
						updatedAt: new Date(),
						revision: sql`${inbox.revision}+1`,
					})
					.where(
						and(
							eq(inbox.id, inboxId),
							eq(inbox.state, "processing"),
							eq(inbox.leaseToken, token),
						),
					)
					.returning();
				if (!done) throw new InvoiceNinjaError("conflict");
				await releaseBinding(tx, binding.id, token);
			});
			return { status: "processed" as const };
		} catch (error) {
			const safe = failure(error);
			const retry =
				!terminal && ["unavailable", "deadline_exceeded"].includes(safe.code);
			await transaction(async (tx) => {
				await tx
					.update(inbox)
					.set({
						state: retry ? "received" : "failed",
						errorCode: safe.code,
						leaseToken: null,
						leaseUntil: null,
						updatedAt: new Date(),
						revision: sql`${inbox.revision}+1`,
					})
					.where(
						and(
							eq(inbox.id, inboxId),
							claimed
								? eq(inbox.leaseToken, token)
								: eq(inbox.state, "received"),
						),
					);
				if (b) await releaseBinding(tx, b.id, token);
			});
			if (retry) throw safe;
			return { status: "ignored" as const, errorCode: safe.code };
		}
	}
	/** Explicit, bounded operator/Jobs recovery only; no startup scan or network. */
	async function recover(tx: Database, limit = 25) {
		parse(z.number().int().min(1).max(100), limit);
		const stale = await tx
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.status, "dispatching"),
					lt(operations.leaseUntil, new Date()),
				),
			)
			.limit(limit);
		for (const row of stale) {
			const [changed] = await tx
				.update(operations)
				.set({
					status:
						row.kind === "create_draft" ? "reconciliation_required" : "queued",
					errorCode: "unavailable",
					leaseToken: null,
					leaseUntil: null,
					updatedAt: new Date(),
					revision: sql`${operations.revision}+1`,
				})
				.where(
					and(
						eq(operations.id, row.id),
						eq(operations.revision, row.revision),
						eq(operations.status, "dispatching"),
					),
				)
				.returning();
			if (changed) {
				if (row.bindingId && row.leaseToken)
					await releaseBinding(tx, row.bindingId, row.leaseToken);
				if (row.kind !== "create_draft")
					await w.enqueue(tx, "operation", row.id);
			}
		}
		const receipts = await tx
			.select()
			.from(inbox)
			.where(
				and(eq(inbox.state, "processing"), lt(inbox.leaseUntil, new Date())),
			)
			.limit(limit);
		for (const row of receipts) {
			const [changed] = await tx
				.update(inbox)
				.set({
					state: "received",
					leaseToken: null,
					leaseUntil: null,
					updatedAt: new Date(),
					revision: sql`${inbox.revision}+1`,
				})
				.where(and(eq(inbox.id, row.id), eq(inbox.revision, row.revision)))
				.returning();
			if (changed) {
				if (row.bindingId && row.leaseToken)
					await releaseBinding(tx, row.bindingId, row.leaseToken);
				await w.enqueue(tx, "receipt", row.id);
			}
		}
		return { processed: stale.length + receipts.length };
	}
	/** Explicit trusted operator decision; never exposed by the reference browser routes. */
	async function resolveAmbiguousDraft(
		ctx: TrustedContext,
		input: unknown,
		decision: unknown,
	) {
		const { operationId } = parse(operationRef, input);
		const resolution = parse(
			z.discriminatedUnion("mode", [
				z.strictObject({
					mode: z.literal("attach-existing"),
					remoteId: opaqueId,
				}),
				z.strictObject({ mode: z.literal("confirm-not-created") }),
			]),
			decision,
		);
		const signal = workerSignal(ctx.signal);
		await scope(ctx, signal);
		const [row] = await db
			.select()
			.from(operations)
			.where(
				and(
					eq(operations.id, operationId),
					eq(operations.scopeKind, ctx.scope.kind),
					eq(operations.scopeId, ctx.scope.id),
				),
			);
		if (!row || row.kind !== "create_draft" || !row.bindingId)
			throw new InvoiceNinjaError("not_found");
		if (row.status !== "reconciliation_required")
			throw new InvoiceNinjaError("conflict");
		const parent = await bound(db, row.bindingId, ctx, "client", signal);
		if (
			row.remoteId &&
			(resolution.mode !== "attach-existing" ||
				row.remoteId !== resolution.remoteId)
		)
			throw new InvoiceNinjaError("conflict");
		let state: Record<string, unknown> | undefined;
		if (resolution.mode === "attach-existing") {
			const response = await providerRequest(
				await connection(row.connectionId, signal),
				"invoice",
				resolution.remoteId,
				{ signal },
			);
			if (response.status !== 200)
				throw new InvoiceNinjaError(
					response.status === 404 ? "not_found" : "unavailable",
				);
			state = entity(response.body);
			if (
				remoteId(state.id) !== resolution.remoteId ||
				state.client_id !== parent.remoteId
			)
				throw new InvoiceNinjaError("conflict");
		}
		return transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(operations)
				.where(eq(operations.id, row.id))
				.for("update");
			if (
				!current ||
				current.status !== "reconciliation_required" ||
				current.revision !== row.revision
			)
				throw new InvoiceNinjaError("conflict");
			await tx
				.select({ id: bindings.id })
				.from(bindings)
				.where(eq(bindings.id, parent.id))
				.for("update");
			const source = await bound(tx, parent.id, ctx, "client", signal);
			let target = source,
				unsupported = false;
			if (resolution.mode === "attach-existing") {
				const resolvedState = state;
				if (!resolvedState) throw new InvoiceNinjaError("unsupported");
				const token = randomUUID();
				target = {
					...source,
					id: randomUUID(),
					resourceKind: "invoice",
					localResourceId: row.id,
					remoteId: resolution.remoteId,
					createdAt: new Date(),
					revision: 0,
					leaseToken: token,
					leaseUntil: new Date(Date.now() + 45000),
				};
				const [inserted] = await tx
					.insert(bindings)
					.values(target)
					.onConflictDoNothing()
					.returning();
				if (!inserted) throw new InvoiceNinjaError("conflict");
				unsupported = await saveProjection(
					tx,
					target,
					token,
					resolvedState,
					ctx,
					signal,
				);
				await releaseBinding(tx, target.id, token);
			}
			await tx
				.update(operations)
				.set({
					status:
						resolution.mode === "confirm-not-created" || unsupported
							? "failed"
							: "succeeded",
					bindingId: target.id,
					remoteId:
						resolution.mode === "attach-existing" ? resolution.remoteId : null,
					errorCode:
						resolution.mode === "confirm-not-created"
							? "cancelled"
							: unsupported
								? "unsupported"
								: null,
					updatedAt: new Date(),
					revision: sql`${operations.revision}+1`,
				})
				.where(eq(operations.id, row.id));
			signal.throwIfAborted();
		});
	}
	async function repairReceipt(tx: Database, inboxId: string) {
		parse(uuid, inboxId);
		const [row] = await tx
			.update(inbox)
			.set({
				state: "received",
				errorCode: null,
				updatedAt: new Date(),
				revision: sql`${inbox.revision}+1`,
			})
			.where(and(eq(inbox.id, inboxId), eq(inbox.state, "failed")))
			.returning();
		if (row) await w.enqueue(tx, "receipt", inboxId);
		return !!row;
	}
	return {
		createBinding,
		retireBinding,
		getClient,
		getInvoice,
		getOperation,
		listInvoices,
		requestClientReconciliation: (ctx: TrustedContext, input: unknown) =>
			requestReconciliation(ctx, input, "client"),
		requestInvoiceReconciliation: (ctx: TrustedContext, input: unknown) =>
			requestReconciliation(ctx, input, "invoice"),
		requestDraftInvoice,
		requestDraftInvoiceInTransaction,
		requestClientReconciliationInTransaction: (
			tx: Database,
			ctx: TrustedContext,
			input: unknown,
		) => requestReconciliationInTransaction(tx, ctx, input, "client"),
		requestInvoiceReconciliationInTransaction: (
			tx: Database,
			ctx: TrustedContext,
			input: unknown,
		) => requestReconciliationInTransaction(tx, ctx, input, "invoice"),
		cancelOperation,
		receiptInTransaction,
		receive,
		runOperation,
		runReceipt,
		recover,
		repairReceipt,
		resolveAmbiguousDraft,
	};
}
