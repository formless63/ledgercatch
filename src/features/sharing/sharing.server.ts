/**
 * Read-only entity sharing.
 *
 * Two strictly separated halves:
 *  - Owner functions (`*ForOwner`) manage invites for the owner's entities.
 *  - Grantee functions (`*ForGrantee`) take a `Grant` that only
 *    `requireGrant(userId, entityId)` can produce. Every grantee query is
 *    scoped by BOTH `grant.ownerId` and `grant.entityId`; owner functions are
 *    never called with a grantee's id.
 */
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNull,
	lte,
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import { user as users } from "#/db/schema";
import { env } from "#/env";
import {
	type AuditWriter,
	appendAuditEvent,
	createAuditActor,
	createAuditSubject,
} from "#/integrations/audit-log/audit.server";
import { auth } from "#/lib/auth";
import { minorToDecimal, toCsv } from "../backup/csv";
import {
	allocations,
	categories,
	claims,
	documents,
	entities,
	orderItems,
	orders,
	paymentMethods,
} from "../ledger/schema";
import { entityShares } from "./schema";
import {
	allocationSlice,
	evaluateAcceptance,
	generateShareToken,
	hashShareToken,
	INVITE_TTL_MS,
	isValidEmail,
	itemsForEntity,
	monthlyTotals,
	normalizeEmail,
	SHARED_DOCUMENT_KINDS,
	shareStatus,
} from "./scope";

export class SharingError extends Error {
	constructor(
		readonly code:
			| "UNAUTHORIZED"
			| "NOT_FOUND"
			| "FORBIDDEN"
			| "INVALID"
			| "CONFLICT",
		message?: string,
	) {
		super(message ?? code);
		this.name = "SharingError";
	}
}

export async function requireSessionUser() {
	const { getRequestHeaders } = await import("@tanstack/react-start/server");
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!session?.user) throw new SharingError("UNAUTHORIZED");
	return session.user;
}

async function audit(
	tx: AuditWriter,
	actorId: string,
	action: string,
	shareId: string,
	metadata?: Record<string, unknown>,
) {
	await appendAuditEvent(tx, {
		actor: createAuditActor("user", actorId),
		action,
		subject: createAuditSubject("entity_share", shareId),
		outcome: "success",
		metadata: metadata ?? null,
	});
}

function inviteUrl(token: string) {
	const base = env.APP_BASE_URL.replace(/\/+$/, "");
	return `${base}/share/accept?token=${encodeURIComponent(token)}`;
}

/* ───────────────────────── owner side ───────────────────────── */

export async function listSharesForOwner(ownerId: string) {
	const [entityRows, shareRows] = await Promise.all([
		db
			.select({
				id: entities.id,
				name: entities.name,
				shortName: entities.shortName,
				color: entities.color,
				archivedAt: entities.archivedAt,
			})
			.from(entities)
			.where(eq(entities.ownerId, ownerId))
			.orderBy(asc(entities.sort), asc(entities.name)),
		db
			.select({
				id: entityShares.id,
				entityId: entityShares.entityId,
				granteeEmail: entityShares.granteeEmail,
				role: entityShares.role,
				tokenHash: entityShares.tokenHash,
				tokenExpiresAt: entityShares.tokenExpiresAt,
				acceptedUserId: entityShares.acceptedUserId,
				acceptedAt: entityShares.acceptedAt,
				lastAccessedAt: entityShares.lastAccessedAt,
				createdAt: entityShares.createdAt,
				revokedAt: entityShares.revokedAt,
			})
			.from(entityShares)
			.where(eq(entityShares.ownerId, ownerId))
			.orderBy(desc(entityShares.createdAt))
			.limit(200),
	]);
	const now = new Date();
	return {
		entities: entityRows.map((e) => ({
			...e,
			archivedAt: e.archivedAt?.toISOString() ?? null,
		})),
		shares: shareRows.map((s) => ({
			id: s.id,
			entityId: s.entityId,
			granteeEmail: s.granteeEmail,
			role: s.role,
			status: shareStatus({ ...s, ownerId }, now),
			tokenExpiresAt: s.tokenExpiresAt?.toISOString() ?? null,
			acceptedAt: s.acceptedAt?.toISOString() ?? null,
			lastAccessedAt: s.lastAccessedAt?.toISOString() ?? null,
			createdAt: s.createdAt.toISOString(),
			revokedAt: s.revokedAt?.toISOString() ?? null,
		})),
	};
}
export type OwnerShareList = Awaited<ReturnType<typeof listSharesForOwner>>;

async function sendInviteEmail(input: {
	to: string;
	url: string;
	entityName: string;
	ownerName: string;
}) {
	try {
		const { getApplicationEmail } = await import("#/lib/email.server");
		const esc = (value: string) =>
			value.replace(
				/[&<>"']/g,
				(c) =>
					({
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
						'"': "&quot;",
						"'": "&#39;",
					})[c] ?? c,
			);
		const subject = `${input.ownerName} shared ${input.entityName} with you (read-only)`;
		const text = `${input.ownerName} gave you read-only access to the books of ${input.entityName} in ${env.APP_NAME}.\n\nAccept the invitation (sign in with this email address):\n${input.url}\n\nThe link expires in 14 days and can be used once.`;
		const html = `<!doctype html><html lang="en"><body><p>${esc(input.ownerName)} gave you read-only access to the books of <strong>${esc(input.entityName)}</strong> in ${esc(env.APP_NAME)}.</p><p><a href="${esc(input.url)}">Accept the invitation</a> (sign in with this email address).</p><p>The link expires in 14 days and can be used once.</p></body></html>`;
		const result = await getApplicationEmail().sendEmail({
			to: [{ address: input.to }],
			subject,
			text,
			html,
		});
		return result.outcome === "accepted";
	} catch {
		return false;
	}
}

/**
 * Invite (or re-invite) `email` as a viewer of `entityId`. Returns the invite
 * URL so the owner can copy it when email delivery is unavailable.
 */
export async function createShareForOwner(
	ownerId: string,
	input: { entityId: string; email: string },
) {
	const email = normalizeEmail(input.email);
	if (!isValidEmail(email))
		throw new SharingError("INVALID", "Enter a valid email address.");
	const [owner] = await db
		.select({ email: users.email, name: users.name })
		.from(users)
		.where(eq(users.id, ownerId));
	if (!owner) throw new SharingError("UNAUTHORIZED");
	if (normalizeEmail(owner.email) === email)
		throw new SharingError("INVALID", "You cannot share with yourself.");
	const [entity] = await db
		.select({ id: entities.id, name: entities.name })
		.from(entities)
		.where(
			and(
				eq(entities.id, input.entityId),
				eq(entities.ownerId, ownerId),
				isNull(entities.archivedAt),
			),
		);
	if (!entity) throw new SharingError("NOT_FOUND", "Entity not found.");

	const token = generateShareToken();
	const tokenHash = hashShareToken(token);
	const tokenExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
	const shareId = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({
				id: entityShares.id,
				acceptedUserId: entityShares.acceptedUserId,
			})
			.from(entityShares)
			.where(
				and(
					eq(entityShares.ownerId, ownerId),
					eq(entityShares.entityId, entity.id),
					eq(entityShares.granteeEmail, email),
					isNull(entityShares.revokedAt),
				),
			)
			.for("update");
		if (existing?.acceptedUserId)
			throw new SharingError(
				"CONFLICT",
				"This person already has access to this entity.",
			);
		if (existing) {
			await tx
				.update(entityShares)
				.set({ tokenHash, tokenExpiresAt })
				.where(eq(entityShares.id, existing.id));
			await audit(tx, ownerId, "share.reissued", existing.id, {
				entityId: entity.id,
				granteeEmail: email,
			});
			return existing.id;
		}
		const [created] = await tx
			.insert(entityShares)
			.values({
				ownerId,
				entityId: entity.id,
				granteeEmail: email,
				role: "viewer",
				tokenHash,
				tokenExpiresAt,
			})
			.returning({ id: entityShares.id });
		if (!created) throw new Error("Share insert failed");
		await audit(tx, ownerId, "share.invited", created.id, {
			entityId: entity.id,
			granteeEmail: email,
			role: "viewer",
		});
		return created.id;
	});
	const url = inviteUrl(token);
	const emailed = await sendInviteEmail({
		to: email,
		url,
		entityName: entity.name,
		ownerName: owner.name || owner.email,
	});
	return { shareId, inviteUrl: url, emailed };
}

export async function revokeShareForOwner(ownerId: string, shareId: string) {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.update(entityShares)
			.set({ revokedAt: new Date(), tokenHash: null })
			.where(
				and(
					eq(entityShares.id, shareId),
					eq(entityShares.ownerId, ownerId),
					isNull(entityShares.revokedAt),
				),
			)
			.returning({
				id: entityShares.id,
				entityId: entityShares.entityId,
				granteeEmail: entityShares.granteeEmail,
			});
		if (!row) throw new SharingError("NOT_FOUND", "Share not found.");
		await audit(tx, ownerId, "share.revoked", row.id, {
			entityId: row.entityId,
			granteeEmail: row.granteeEmail,
		});
	});
	return { ok: true as const };
}

/* ───────────────────────── grantee side ───────────────────────── */

const ACCEPT_MESSAGES = {
	invalid_token: "This invitation link is invalid or was already used.",
	revoked: "This invitation was revoked.",
	expired: "This invitation has expired. Ask for a new one.",
	already_accepted: "You already accepted this invitation.",
	email_mismatch:
		"This invitation was sent to a different email address. Sign in with that address.",
	email_unverified: "Verify your email address first (sign in by magic link).",
	self_share: "You own this entity.",
} as const;

export async function acceptShareForUser(
	viewer: { id: string; email: string; emailVerified: boolean },
	token: string,
) {
	const tokenHash = hashShareToken(token);
	const [share] = await db
		.select()
		.from(entityShares)
		.where(eq(entityShares.tokenHash, tokenHash));
	if (!share) throw new SharingError("INVALID", ACCEPT_MESSAGES.invalid_token);
	const verdict = evaluateAcceptance(share, token, viewer);
	if (!verdict.ok) {
		if (verdict.reason === "already_accepted")
			return { entityId: share.entityId };
		throw new SharingError("FORBIDDEN", ACCEPT_MESSAGES[verdict.reason]);
	}
	await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(entityShares)
			.set({
				acceptedUserId: viewer.id,
				acceptedAt: new Date(),
				tokenHash: null,
				tokenExpiresAt: null,
			})
			.where(
				and(
					eq(entityShares.id, share.id),
					isNull(entityShares.acceptedUserId),
					isNull(entityShares.revokedAt),
				),
			)
			.returning({ id: entityShares.id });
		if (!updated)
			throw new SharingError("CONFLICT", ACCEPT_MESSAGES.invalid_token);
		await audit(tx, viewer.id, "share.accepted", share.id, {
			entityId: share.entityId,
			ownerId: share.ownerId,
		});
	});
	return { entityId: share.entityId };
}

/** Proof of an active share for (user, entity). Only requireGrant creates one. */
export type Grant = {
	readonly shareId: string;
	readonly viewerId: string;
	readonly ownerId: string;
	readonly entityId: string;
	readonly entity: {
		name: string;
		shortName: string | null;
		color: string;
		kind: string;
	};
};

const ACCESS_TOUCH_MS = 5 * 60_000;

export async function requireGrant(
	viewerId: string,
	entityId: string,
): Promise<Grant> {
	if (!/^[0-9a-f-]{36}$/i.test(entityId)) throw new SharingError("NOT_FOUND");
	const [row] = await db
		.select({
			shareId: entityShares.id,
			ownerId: entityShares.ownerId,
			entityId: entityShares.entityId,
			lastAccessedAt: entityShares.lastAccessedAt,
			name: entities.name,
			shortName: entities.shortName,
			color: entities.color,
			kind: entities.kind,
		})
		.from(entityShares)
		.innerJoin(
			entities,
			and(
				eq(entities.id, entityShares.entityId),
				// The entity must still belong to the sharing owner.
				eq(entities.ownerId, entityShares.ownerId),
			),
		)
		.where(
			and(
				eq(entityShares.entityId, entityId),
				eq(entityShares.acceptedUserId, viewerId),
				isNull(entityShares.revokedAt),
			),
		)
		.limit(1);
	if (!row) throw new SharingError("NOT_FOUND", "No access to this entity.");
	if (
		!row.lastAccessedAt ||
		Date.now() - row.lastAccessedAt.getTime() > ACCESS_TOUCH_MS
	)
		void db
			.update(entityShares)
			.set({ lastAccessedAt: new Date() })
			.where(eq(entityShares.id, row.shareId))
			.catch(() => {});
	return Object.freeze({
		shareId: row.shareId,
		viewerId,
		ownerId: row.ownerId,
		entityId: row.entityId,
		entity: {
			name: row.name,
			shortName: row.shortName,
			color: row.color,
			kind: row.kind,
		},
	});
}

/** Entities shared with the viewer (accepted, not revoked). */
export async function listSharesForViewer(viewerId: string) {
	const rows = await db
		.select({
			shareId: entityShares.id,
			entityId: entities.id,
			name: entities.name,
			shortName: entities.shortName,
			color: entities.color,
			kind: entities.kind,
			ownerName: users.name,
			ownerEmail: users.email,
			acceptedAt: entityShares.acceptedAt,
		})
		.from(entityShares)
		.innerJoin(
			entities,
			and(
				eq(entities.id, entityShares.entityId),
				eq(entities.ownerId, entityShares.ownerId),
			),
		)
		.innerJoin(users, eq(users.id, entityShares.ownerId))
		.where(
			and(
				eq(entityShares.acceptedUserId, viewerId),
				isNull(entityShares.revokedAt),
			),
		)
		.orderBy(asc(entities.name));
	return rows.map((row) => ({
		...row,
		acceptedAt: row.acceptedAt?.toISOString() ?? null,
	}));
}
export type ViewerShare = Awaited<
	ReturnType<typeof listSharesForViewer>
>[number];

export type SharedRange = { from?: string; to?: string; q?: string };

/** The one place that defines which allocation rows a grant can see. */
function allocationScope(grant: Grant, range: SharedRange = {}): SQL[] {
	const where: SQL[] = [
		eq(allocations.entityId, grant.entityId),
		eq(orders.ownerId, grant.ownerId),
		ne(orders.reviewState, "ignored"),
	];
	if (range.from) where.push(gte(orders.orderDate, range.from));
	if (range.to) where.push(lte(orders.orderDate, range.to));
	const q = range.q?.trim();
	if (q) {
		const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
		const match = or(
			ilike(orders.merchantName, pattern),
			ilike(orders.externalOrderId, pattern),
			ilike(orders.source, pattern),
		);
		if (match) where.push(match);
	}
	return where;
}

function sharedRowsQuery(grant: Grant, range: SharedRange) {
	return db
		.select({
			allocationId: allocations.id,
			orderId: orders.id,
			orderDate: orders.orderDate,
			source: orders.source,
			merchantName: orders.merchantName,
			externalOrderId: orders.externalOrderId,
			status: orders.status,
			reviewState: orders.reviewState,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
			reimbursable: allocations.reimbursable,
			reimbursementStatus: allocations.reimbursementStatus,
			categoryName: categories.name,
			categoryCode: categories.code,
			// Boolean only: other entities' ids and amounts are never selected.
			sharedOrder: sql<boolean>`exists (select 1 from ${allocations} a2 where a2.order_id = ${orders.id} and a2.entity_id <> ${grant.entityId})`,
			hasInvoice: sql<boolean>`exists (select 1 from ${documents} d where d.order_id = ${orders.id} and d.owner_id = ${grant.ownerId} and d.kind in ('invoice', 'receipt'))`,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.leftJoin(
			categories,
			and(
				eq(categories.id, allocations.categoryId),
				eq(categories.ownerId, grant.ownerId),
			),
		)
		.where(and(...allocationScope(grant, range)));
}

export async function getSharedSummaryForGrantee(
	grant: Grant,
	range: SharedRange,
) {
	const rows = await db
		.select({
			orderDate: orders.orderDate,
			currency: allocations.currency,
			amountMinor: allocations.amountMinor,
			reimbursementStatus: allocations.reimbursementStatus,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(and(...allocationScope(grant, { from: range.from, to: range.to })));
	const totals = new Map<string, number>();
	const reimbursement = new Map<
		string,
		{ status: string; currency: string; totalMinor: number }
	>();
	for (const row of rows) {
		totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountMinor);
		if (row.reimbursementStatus !== "none") {
			const key = `${row.reimbursementStatus}|${row.currency}`;
			const bucket = reimbursement.get(key) ?? {
				status: row.reimbursementStatus,
				currency: row.currency,
				totalMinor: 0,
			};
			bucket.totalMinor += row.amountMinor;
			reimbursement.set(key, bucket);
		}
	}
	return {
		entity: grant.entity,
		orderCount: rows.length,
		totals: [...totals.entries()].map(([currency, totalMinor]) => ({
			currency,
			totalMinor,
		})),
		months: monthlyTotals(rows),
		reimbursement: [...reimbursement.values()],
	};
}

export async function listSharedOrdersForGrantee(
	grant: Grant,
	input: SharedRange & { limit?: number; offset?: number },
) {
	const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
	const offset = Math.max(input.offset ?? 0, 0);
	const [rows, [total]] = await Promise.all([
		sharedRowsQuery(grant, input)
			.orderBy(desc(orders.orderDate), desc(orders.firstSeenAt))
			.limit(limit)
			.offset(offset),
		db
			.select({ n: count() })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(...allocationScope(grant, input))),
	]);
	return { rows, total: total?.n ?? 0, limit, offset };
}
export type SharedOrderRow = Awaited<
	ReturnType<typeof listSharedOrdersForGrantee>
>["rows"][number];

export async function getSharedOrderForGrantee(grant: Grant, orderId: string) {
	if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new SharingError("NOT_FOUND");
	const [order] = await db
		.select({
			id: orders.id,
			entityId: orders.entityId,
			source: orders.source,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			orderUrl: orders.orderUrl,
			orderDate: orders.orderDate,
			status: orders.status,
			reviewState: orders.reviewState,
			currency: orders.currency,
			paymentLast4: paymentMethods.last4,
		})
		.from(orders)
		.leftJoin(
			paymentMethods,
			and(
				eq(paymentMethods.id, orders.paymentMethodId),
				eq(paymentMethods.ownerId, grant.ownerId),
			),
		)
		.where(
			and(
				eq(orders.id, orderId),
				eq(orders.ownerId, grant.ownerId),
				ne(orders.reviewState, "ignored"),
			),
		);
	if (!order) throw new SharingError("NOT_FOUND", "Order not found.");
	const allocationRows = await db
		.select({
			entityId: allocations.entityId,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
			reimbursable: allocations.reimbursable,
			reimbursementStatus: allocations.reimbursementStatus,
			categoryId: allocations.categoryId,
		})
		.from(allocations)
		.where(eq(allocations.orderId, order.id));
	const slice = allocationSlice(allocationRows, grant.entityId);
	if (!slice.own) throw new SharingError("NOT_FOUND", "Order not found.");
	const own = slice.own;
	const [category, itemRows, docRows] = await Promise.all([
		own.categoryId
			? db
					.select({ name: categories.name, code: categories.code })
					.from(categories)
					.where(
						and(
							eq(categories.id, own.categoryId),
							eq(categories.ownerId, grant.ownerId),
						),
					)
					.then((rows) => rows[0] ?? null)
			: Promise.resolve(null),
		db
			.select({
				id: orderItems.id,
				title: orderItems.title,
				sku: orderItems.sku,
				variant: orderItems.variant,
				quantity: orderItems.quantity,
				unitPriceMinor: orderItems.unitPriceMinor,
				totalMinor: orderItems.totalMinor,
				entityId: orderItems.entityId,
			})
			.from(orderItems)
			.where(eq(orderItems.orderId, order.id))
			.orderBy(asc(orderItems.position)),
		db
			.select({
				id: documents.id,
				kind: documents.kind,
				fileName: documents.fileName,
				contentType: documents.contentType,
				sizeBytes: documents.sizeBytes,
				createdAt: documents.createdAt,
			})
			.from(documents)
			.where(
				and(
					eq(documents.orderId, order.id),
					eq(documents.ownerId, grant.ownerId),
					inArray(documents.kind, [...SHARED_DOCUMENT_KINDS]),
				),
			)
			.orderBy(asc(documents.createdAt)),
	]);
	const { entityId: primaryEntityId, ...header } = order;
	return {
		order: header,
		allocation: {
			amountMinor: own.amountMinor,
			currency: own.currency,
			reimbursable: own.reimbursable,
			reimbursementStatus: own.reimbursementStatus,
			categoryName: category?.name ?? null,
			categoryCode: category?.code ?? null,
		},
		sharedOrder: slice.shared,
		items: itemsForEntity(itemRows, primaryEntityId, grant.entityId).map(
			({ entityId: _e, ...item }) => item,
		),
		documents: docRows.map((doc) => ({
			...doc,
			createdAt: doc.createdAt.toISOString(),
		})),
	};
}
export type SharedOrderDetail = Awaited<
	ReturnType<typeof getSharedOrderForGrantee>
>;

export async function listSharedClaimsForGrantee(grant: Grant) {
	const claimRows = await db
		.select({
			id: claims.id,
			payerEntityId: claims.payerEntityId,
			owingEntityId: claims.owingEntityId,
			status: claims.status,
			currency: claims.currency,
			totalMinor: claims.totalMinor,
			reference: claims.reference,
			createdAt: claims.createdAt,
			submittedAt: claims.submittedAt,
			paidAt: claims.paidAt,
		})
		.from(claims)
		.where(
			and(
				eq(claims.ownerId, grant.ownerId),
				or(
					eq(claims.payerEntityId, grant.entityId),
					eq(claims.owingEntityId, grant.entityId),
				),
				ne(claims.status, "void"),
			),
		)
		.orderBy(desc(claims.createdAt))
		.limit(500);
	if (claimRows.length === 0) return [];
	const counterpartyIds = [
		...new Set(
			claimRows.map((c) =>
				c.payerEntityId === grant.entityId ? c.owingEntityId : c.payerEntityId,
			),
		),
	];
	const [entityRows, lineRows] = await Promise.all([
		db
			.select({ id: entities.id, name: entities.name, color: entities.color })
			.from(entities)
			.where(
				and(
					eq(entities.ownerId, grant.ownerId),
					inArray(entities.id, counterpartyIds),
				),
			),
		db
			.select({
				claimId: allocations.claimId,
				orderId: orders.id,
				allocationEntityId: allocations.entityId,
				orderDate: orders.orderDate,
				merchantName: orders.merchantName,
				source: orders.source,
				externalOrderId: orders.externalOrderId,
				amountMinor: allocations.amountMinor,
				currency: allocations.currency,
				reimbursementStatus: allocations.reimbursementStatus,
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(
				and(
					eq(orders.ownerId, grant.ownerId),
					inArray(
						allocations.claimId,
						claimRows.map((c) => c.id),
					),
				),
			)
			.orderBy(asc(orders.orderDate)),
	]);
	const entityById = new Map(entityRows.map((e) => [e.id, e]));
	return claimRows.map((claim) => {
		const direction =
			claim.payerEntityId === grant.entityId ? "receivable" : "payable";
		const counterpartyId =
			direction === "receivable" ? claim.owingEntityId : claim.payerEntityId;
		return {
			id: claim.id,
			direction,
			counterparty: entityById.get(counterpartyId) ?? null,
			status: claim.status,
			currency: claim.currency,
			totalMinor: claim.totalMinor,
			reference: claim.reference,
			createdAt: claim.createdAt.toISOString(),
			submittedAt: claim.submittedAt?.toISOString() ?? null,
			paidAt: claim.paidAt?.toISOString() ?? null,
			lines: lineRows
				.filter((line) => line.claimId === claim.id)
				.map(({ claimId: _c, allocationEntityId, ...line }) => ({
					...line,
					// Order detail is only reachable for the viewer's own allocations.
					viewable: allocationEntityId === grant.entityId,
				})),
		};
	});
}
export type SharedClaim = Awaited<
	ReturnType<typeof listSharedClaimsForGrantee>
>[number];

export async function exportSharedCsvForGrantee(
	grant: Grant,
	range: SharedRange,
) {
	const rows = await sharedRowsQuery(grant, range)
		.orderBy(asc(orders.orderDate))
		.limit(50_000);
	const csv = toCsv(
		[
			"order_date",
			"store",
			"merchant",
			"order_reference",
			"order_status",
			"category_code",
			"category",
			"amount",
			"currency",
			"reimbursable",
			"reimbursement_status",
			"shared_order",
			"has_invoice",
		],
		rows.map((row) => [
			row.orderDate,
			row.source,
			row.merchantName,
			row.externalOrderId,
			row.status,
			row.categoryCode,
			row.categoryName,
			minorToDecimal(row.amountMinor, row.currency),
			row.currency,
			row.reimbursable,
			row.reimbursementStatus,
			row.sharedOrder,
			row.hasInvoice,
		]),
	);
	await audit(db, grant.viewerId, "share.exported", grant.shareId, {
		entityId: grant.entityId,
		rows: rows.length,
		from: range.from ?? null,
		to: range.to ?? null,
	});
	const slug =
		(grant.entity.shortName || grant.entity.name)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "entity";
	const suffix = [range.from, range.to].filter(Boolean).join("_to_");
	return {
		fileName: `${slug}-expenses${suffix ? `-${suffix}` : ""}.csv`,
		csv,
	};
}

/** Resolve a document the grant may download; null when out of scope. */
export async function findSharedDocumentForGrantee(
	grant: Grant,
	documentId: string,
) {
	if (!/^[0-9a-f-]{36}$/i.test(documentId)) return null;
	const [doc] = await db
		.select({
			id: documents.id,
			fileName: documents.fileName,
			contentType: documents.contentType,
			storageKey: documents.storageKey,
			orderId: documents.orderId,
		})
		.from(documents)
		.innerJoin(orders, eq(orders.id, documents.orderId))
		.innerJoin(
			allocations,
			and(
				eq(allocations.orderId, orders.id),
				eq(allocations.entityId, grant.entityId),
			),
		)
		.where(
			and(
				eq(documents.id, documentId),
				eq(documents.ownerId, grant.ownerId),
				eq(orders.ownerId, grant.ownerId),
				ne(orders.reviewState, "ignored"),
				inArray(documents.kind, [...SHARED_DOCUMENT_KINDS]),
			),
		)
		.limit(1);
	return doc ?? null;
}

export async function auditSharedDownload(grant: Grant, documentId: string) {
	await audit(db, grant.viewerId, "share.document_downloaded", grant.shareId, {
		entityId: grant.entityId,
		documentId,
	}).catch(() => {});
}
