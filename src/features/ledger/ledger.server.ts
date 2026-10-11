/**
 * Owner-scoped queries and mutations behind the ledger UI. Every function
 * resolves the session user first; nothing trusts client-supplied owners.
 */
import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	gte,
	inArray,
	isNull,
	lte,
	notExists,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { claimableAllocationsForOwner } from "#/features/lifecycle/refunds.server";
import { documentLinks } from "#/features/lifecycle/schema";
import { loadCaptureBody } from "#/features/ops/compaction.server";
import {
	appendAuditEvent,
	createAuditActor,
	createAuditSubject,
} from "#/integrations/audit-log/audit.server";
import { auditEvents } from "#/integrations/audit-log/schema";
import { auth } from "#/lib/auth";
import { getApplicationStorage } from "#/lib/storage.server";
import { requeueCapture } from "./captures.server";
import type {
	bulkOrderUpdateInput,
	captureListInput,
	categoryInput,
	claimStatusInput,
	createClaimInput,
	entityInput,
	manualOrderInput,
	orderItemUpdateInput,
	orderListInput,
	orderUpdateInput,
	paymentMethodInput,
	reimbursementStatusInput,
	ruleInput,
} from "./inputs";
import { audit, recomputeAllocations } from "./orders.server";
import { afterClaims, emitClaimPaid, emitOrderEvent } from "./outbound.server";
import { applyRulesToInbox, loadRuleSubject } from "./process.server";
import { evaluateRules, ruleMatches } from "./rules";
import {
	allocations,
	captures,
	categories,
	claims,
	connections,
	documents,
	entities,
	exports,
	orderCaptures,
	orderItems,
	orders,
	paymentMethods,
	rules,
	shipments,
} from "./schema";

export async function requireUser() {
	// Lazy: worker bundles reuse the *ForOwner cores without the request runtime.
	const { getRequestHeaders } = await import("@tanstack/react-start/server");
	const session = await auth.api.getSession({ headers: getRequestHeaders() });
	if (!session?.user) throw new Error("UNAUTHORIZED");
	return session.user;
}

const toMinor = (decimal: string | undefined) =>
	decimal === undefined ? null : Math.round(Number.parseFloat(decimal) * 100);

async function ownedOrder(ownerId: string, orderId: string) {
	const [row] = await db
		.select({ id: orders.id })
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row.id;
}

async function assertOwnedRefs(
	ownerId: string,
	refs: { categoryId?: string | null; paymentMethodId?: string | null },
) {
	if (refs.categoryId) {
		const [row] = await db
			.select({ id: categories.id })
			.from(categories)
			.where(
				and(
					eq(categories.id, refs.categoryId),
					eq(categories.ownerId, ownerId),
				),
			);
		if (!row) throw new Error("Unknown category");
	}
	if (refs.paymentMethodId) {
		const [row] = await db
			.select({ id: paymentMethods.id })
			.from(paymentMethods)
			.where(
				and(
					eq(paymentMethods.id, refs.paymentMethodId),
					eq(paymentMethods.ownerId, ownerId),
				),
			);
		if (!row) throw new Error("Unknown payment method");
	}
}

async function assertOwnedEntity(
	ownerId: string,
	entityId: string | null | undefined,
) {
	if (!entityId) return;
	const [row] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.id, entityId), eq(entities.ownerId, ownerId)));
	if (!row) throw new Error("Unknown entity");
}

/* ───────────────────────── bootstrap ───────────────────────── */

export async function getBootstrap() {
	const user = await requireUser();
	const [entityRows, categoryRows, methodRows, inbox, pending, failed] =
		await Promise.all([
			db
				.select()
				.from(entities)
				.where(eq(entities.ownerId, user.id))
				.orderBy(asc(entities.sort), asc(entities.name)),
			db
				.select()
				.from(categories)
				.where(eq(categories.ownerId, user.id))
				.orderBy(asc(categories.code), asc(categories.name)),
			db
				.select()
				.from(paymentMethods)
				.where(eq(paymentMethods.ownerId, user.id))
				.orderBy(asc(paymentMethods.label)),
			db
				.select({ n: count() })
				.from(orders)
				.where(
					and(eq(orders.ownerId, user.id), eq(orders.reviewState, "inbox")),
				),
			db
				.select({
					currency: allocations.currency,
					total:
						sql<number>`coalesce(sum(${allocations.amountMinor}), 0)::bigint`.mapWith(
							Number,
						),
					n: count(),
				})
				.from(allocations)
				.innerJoin(orders, eq(orders.id, allocations.orderId))
				.where(
					and(
						eq(orders.ownerId, user.id),
						eq(allocations.reimbursementStatus, "pending"),
					),
				)
				.groupBy(allocations.currency),
			db
				.select({ n: count() })
				.from(captures)
				.where(
					and(
						eq(captures.ownerId, user.id),
						inArray(captures.status, ["failed", "needs_review"]),
					),
				),
		]);
	const [lastCapture] = await db
		.select({
			receivedAt: captures.receivedAt,
			extensionVersion: captures.extensionVersion,
		})
		.from(captures)
		.where(eq(captures.ownerId, user.id))
		.orderBy(desc(captures.receivedAt))
		.limit(1);
	return {
		user: {
			id: user.id,
			name: user.name,
			email: user.email,
			image: user.image ?? null,
		},
		entities: entityRows,
		categories: categoryRows,
		paymentMethods: methodRows,
		counts: {
			inbox: inbox[0]?.n ?? 0,
			capturesNeedingAttention: failed[0]?.n ?? 0,
			pendingReimbursement: pending,
		},
		lastCapture: lastCapture
			? {
					receivedAt: lastCapture.receivedAt.toISOString(),
					extensionVersion: lastCapture.extensionVersion,
				}
			: null,
		onboarded: entityRows.length > 0,
	};
}

/* ───────────────────────── orders ───────────────────────── */

export async function listOrders(input: z.output<typeof orderListInput>) {
	return listOrdersForOwner((await requireUser()).id, input);
}

export async function listOrdersForOwner(
	ownerId: string,
	input: z.output<typeof orderListInput>,
) {
	const user = { id: ownerId };
	const where: SQL[] = [eq(orders.ownerId, user.id)];
	if (input.view !== "all") where.push(eq(orders.reviewState, input.view));
	if (input.entityId === "unassigned") where.push(isNull(orders.entityId));
	else if (input.entityId)
		where.push(
			sql`(${orders.entityId} = ${input.entityId} or exists (select 1 from ${allocations} a where a.order_id = "orders"."id" and a.entity_id = ${input.entityId}))`,
		);
	if (input.source) where.push(eq(orders.source, input.source));
	if (input.status) where.push(eq(orders.status, input.status as never));
	if (input.from) where.push(gte(orders.orderDate, input.from));
	if (input.to) where.push(lte(orders.orderDate, input.to));
	if (input.reimbursement) {
		const statusClause =
			input.reimbursement === "reimbursable"
				? eq(allocations.reimbursable, true)
				: eq(allocations.reimbursementStatus, input.reimbursement);
		where.push(
			exists(
				db
					.select({ one: sql`1` })
					.from(allocations)
					.where(and(eq(allocations.orderId, orders.id), statusClause)),
			),
		);
	}
	if (input.missingInvoice)
		where.push(
			notExists(
				db
					.select({ one: sql`1` })
					.from(documents)
					.where(
						and(
							eq(documents.orderId, orders.id),
							inArray(documents.kind, ["invoice", "receipt"]),
						),
					),
			),
		);
	if (input.q) {
		const query = input.q;
		where.push(
			sql`(${orders.searchVector} @@ websearch_to_tsquery('simple', ${query}) or ${orders.externalOrderId} ilike ${`%${query}%`} or ${orders.merchantName} ilike ${`%${query}%`})`,
		);
	}
	const orderBy =
		input.sort === "date_asc"
			? [asc(orders.orderDate), asc(orders.firstSeenAt)]
			: input.sort === "total_desc"
				? [sql`${orders.totalMinor} desc nulls last`]
				: input.sort === "captured_desc"
					? [desc(orders.lastCapturedAt)]
					: [
							sql`${orders.orderDate} desc nulls last`,
							desc(orders.firstSeenAt),
						];

	const rows = await db
		.select({
			id: orders.id,
			source: orders.source,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			orderUrl: orders.orderUrl,
			orderDate: orders.orderDate,
			status: orders.status,
			statusText: orders.statusText,
			currency: orders.currency,
			totalMinor: orders.totalMinor,
			taxMinor: orders.taxMinor,
			entityId: orders.entityId,
			categoryId: orders.categoryId,
			paymentMethodId: orders.paymentMethodId,
			paymentHint: orders.paymentHint,
			reimbursableOverride: orders.reimbursableOverride,
			reviewState: orders.reviewState,
			tags: orders.tags,
			ruleId: orders.ruleId,
			firstSeenAt: orders.firstSeenAt,
			lastCapturedAt: orders.lastCapturedAt,
			itemCount:
				sql<number>`(select count(*) from ${orderItems} i where i.order_id = "orders"."id")`.mapWith(
					Number,
				),
			firstItemTitle: sql<
				string | null
			>`(select i.title from ${orderItems} i where i.order_id = "orders"."id" order by i.position limit 1)`,
			firstItemImage: sql<
				string | null
			>`(select i.image_url from ${orderItems} i where i.order_id = "orders"."id" and i.image_url is not null order by i.position limit 1)`,
			documentCount:
				sql<number>`(select count(*) from ${documents} d where (d.order_id = "orders"."id" or exists (select 1 from document_links l where l.document_id = d.id and l.order_id = "orders"."id")) and d.kind in ('invoice','receipt'))`.mapWith(
					Number,
				),
			total: sql<number>`count(*) over()`.mapWith(Number),
		})
		.from(orders)
		.where(and(...where))
		.orderBy(...orderBy)
		.limit(input.limit)
		.offset(input.offset);

	const ids = rows.map((row) => row.id);
	const allocationRows = ids.length
		? await db
				.select({
					id: allocations.id,
					orderId: allocations.orderId,
					entityId: allocations.entityId,
					amountMinor: allocations.amountMinor,
					currency: allocations.currency,
					reimbursable: allocations.reimbursable,
					reimbursementStatus: allocations.reimbursementStatus,
				})
				.from(allocations)
				.where(inArray(allocations.orderId, ids))
		: [];
	const byOrder = new Map<string, typeof allocationRows>();
	for (const row of allocationRows) {
		const list = byOrder.get(row.orderId) ?? [];
		list.push(row);
		byOrder.set(row.orderId, list);
	}
	return {
		total: rows[0]?.total ?? 0,
		orders: rows.map(({ total: _total, ...row }) => ({
			...row,
			firstSeenAt: row.firstSeenAt.toISOString(),
			lastCapturedAt: row.lastCapturedAt.toISOString(),
			allocations: byOrder.get(row.id) ?? [],
		})),
	};
}

export type OrderListResult = Awaited<ReturnType<typeof listOrders>>;
export type OrderListRow = OrderListResult["orders"][number];

export async function getOrder(orderId: string) {
	return getOrderForOwner((await requireUser()).id, orderId);
}

export async function getOrderForOwner(ownerId: string, orderId: string) {
	const user = { id: ownerId };
	const [order] = await db
		.select()
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, user.id)));
	if (!order) throw new Error("NOT_FOUND");
	const [
		items,
		shipmentRows,
		allocationRows,
		documentRows,
		captureRows,
		history,
		exportRows,
	] = await Promise.all([
		db
			.select()
			.from(orderItems)
			.where(eq(orderItems.orderId, orderId))
			.orderBy(asc(orderItems.position)),
		db.select().from(shipments).where(eq(shipments.orderId, orderId)),
		db.select().from(allocations).where(eq(allocations.orderId, orderId)),
		db
			.select({
				id: documents.id,
				kind: documents.kind,
				fileName: documents.fileName,
				contentType: documents.contentType,
				sizeBytes: documents.sizeBytes,
				sha256: documents.sha256,
				originUrl: documents.originUrl,
				createdAt: documents.createdAt,
			})
			.from(documents)
			.where(
				or(
					eq(documents.orderId, orderId),
					inArray(
						documents.id,
						db
							.select({ id: documentLinks.documentId })
							.from(documentLinks)
							.where(eq(documentLinks.orderId, orderId)),
					),
				),
			)
			.orderBy(desc(documents.createdAt)),
		db
			.select({
				id: captures.id,
				kind: captures.kind,
				trigger: captures.trigger,
				pageType: captures.pageType,
				pageUrl: captures.pageUrl,
				status: captures.status,
				parserId: captures.parserId,
				capturedAt: captures.capturedAt,
				error: captures.error,
				screenshotDocumentId: captures.screenshotDocumentId,
			})
			.from(orderCaptures)
			.innerJoin(captures, eq(captures.id, orderCaptures.captureId))
			.where(eq(orderCaptures.orderId, orderId))
			.orderBy(desc(captures.capturedAt)),
		db
			.select()
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.subjectType, "order"),
					eq(auditEvents.subjectId, orderId),
				),
			)
			.orderBy(desc(auditEvents.createdAt))
			.limit(100),
		db
			.select({
				id: exports.id,
				allocationId: exports.allocationId,
				entityId: exports.entityId,
				amountMinor: exports.amountMinor,
				status: exports.status,
				remoteId: exports.remoteId,
				remoteUrl: exports.remoteUrl,
				error: exports.error,
				sentAt: exports.sentAt,
				connectionId: connections.id,
				connectionName: connections.name,
				provider: connections.provider,
			})
			.from(exports)
			.innerJoin(connections, eq(connections.id, exports.connectionId))
			.where(eq(exports.orderId, orderId)),
	]);
	return {
		order: {
			...order,
			searchVector: undefined,
			firstSeenAt: order.firstSeenAt.toISOString(),
			lastCapturedAt: order.lastCapturedAt.toISOString(),
			filedAt: order.filedAt?.toISOString() ?? null,
			updatedAt: order.updatedAt.toISOString(),
		},
		items,
		shipments: shipmentRows.map((s) => ({
			...s,
			updatedAt: s.updatedAt.toISOString(),
		})),
		allocations: allocationRows.map((a) => ({
			...a,
			updatedAt: a.updatedAt.toISOString(),
		})),
		documents: documentRows.map((d) => ({
			...d,
			createdAt: d.createdAt.toISOString(),
		})),
		captures: captureRows.map((c) => ({
			...c,
			capturedAt: c.capturedAt.toISOString(),
		})),
		history: history.map((event) => ({
			id: event.id,
			action: event.action,
			actorType: event.actorType,
			actorId: event.actorId,
			metadata: event.metadata,
			createdAt: event.createdAt.toISOString(),
		})),
		exports: exportRows.map((e) => ({
			...e,
			sentAt: e.sentAt?.toISOString() ?? null,
		})),
	};
}
export type OrderDetail = Awaited<ReturnType<typeof getOrder>>;

export async function updateOrder(input: z.output<typeof orderUpdateInput>) {
	return updateOrderForOwner((await requireUser()).id, input);
}

export async function updateOrderForOwner(
	ownerId: string,
	input: z.output<typeof orderUpdateInput>,
) {
	const user = { id: ownerId };
	await ownedOrder(user.id, input.id);
	await assertOwnedEntity(user.id, input.entityId);
	await assertOwnedRefs(
		user.id,
		input as { categoryId?: string | null; paymentMethodId?: string | null },
	);
	const { id, ...changes } = input;
	const set: Partial<typeof orders.$inferInsert> = { updatedAt: new Date() };
	for (const [key, value] of Object.entries(changes))
		if (value !== undefined) (set as Record<string, unknown>)[key] = value;
	if (changes.reviewState === "filed") set.filedAt = new Date();
	await db.transaction(async (tx) => {
		await tx.update(orders).set(set).where(eq(orders.id, id));
		await recomputeAllocations(tx, id);
		await audit(
			tx,
			{ type: "user", id: user.id },
			"order.updated",
			id,
			changes,
		);
	});
	if (changes.reviewState === "filed")
		void emitOrderEvent(user.id, id, "order.filed");
	if (changes.entityId) void emitOrderEvent(user.id, id, "order.assigned");
	return { ok: true };
}

export async function bulkUpdateOrders(
	input: z.output<typeof bulkOrderUpdateInput>,
) {
	return bulkUpdateOrdersForOwner((await requireUser()).id, input);
}

export async function bulkUpdateOrdersForOwner(
	ownerId: string,
	input: z.output<typeof bulkOrderUpdateInput>,
) {
	const user = { id: ownerId };
	await assertOwnedEntity(user.id, input.entityId);
	await assertOwnedRefs(
		user.id,
		input as { categoryId?: string | null; paymentMethodId?: string | null },
	);
	const owned = await db
		.select({ id: orders.id })
		.from(orders)
		.where(and(eq(orders.ownerId, user.id), inArray(orders.id, input.ids)));
	const { ids: _ids, ...changes } = input;
	const set: Partial<typeof orders.$inferInsert> = { updatedAt: new Date() };
	for (const [key, value] of Object.entries(changes))
		if (value !== undefined) (set as Record<string, unknown>)[key] = value;
	if (changes.reviewState === "filed") set.filedAt = new Date();
	await db.transaction(async (tx) => {
		for (const { id } of owned) {
			await tx.update(orders).set(set).where(eq(orders.id, id));
			await recomputeAllocations(tx, id);
			await audit(
				tx,
				{ type: "user", id: user.id },
				"order.updated",
				id,
				changes,
			);
		}
	});
	for (const { id } of owned) {
		if (changes.reviewState === "filed")
			void emitOrderEvent(user.id, id, "order.filed");
		if (changes.entityId) void emitOrderEvent(user.id, id, "order.assigned");
	}
	return { updated: owned.length };
}

export async function updateOrderItem(
	input: z.output<typeof orderItemUpdateInput>,
) {
	return updateOrderItemForOwner((await requireUser()).id, input);
}

export async function updateOrderItemForOwner(
	ownerId: string,
	input: z.output<typeof orderItemUpdateInput>,
) {
	const user = { id: ownerId };
	const [item] = await db
		.select({ id: orderItems.id, orderId: orderItems.orderId })
		.from(orderItems)
		.innerJoin(orders, eq(orders.id, orderItems.orderId))
		.where(and(eq(orderItems.id, input.itemId), eq(orders.ownerId, user.id)));
	if (!item) throw new Error("NOT_FOUND");
	await assertOwnedEntity(user.id, input.entityId);
	await assertOwnedRefs(
		user.id,
		input as { categoryId?: string | null; paymentMethodId?: string | null },
	);
	const set: Partial<typeof orderItems.$inferInsert> = {};
	if (input.entityId !== undefined) set.entityId = input.entityId;
	if (input.categoryId !== undefined) set.categoryId = input.categoryId;
	await db.transaction(async (tx) => {
		await tx.update(orderItems).set(set).where(eq(orderItems.id, item.id));
		await recomputeAllocations(tx, item.orderId);
		await audit(
			tx,
			{ type: "user", id: user.id },
			"order.item_updated",
			item.orderId,
			{
				itemId: item.id,
				...set,
			},
		);
	});
	return { ok: true };
}

export async function createManualOrder(
	input: z.output<typeof manualOrderInput>,
) {
	return createManualOrderForOwner((await requireUser()).id, input);
}

export async function createManualOrderForOwner(
	ownerId: string,
	input: z.output<typeof manualOrderInput>,
) {
	const user = { id: ownerId };
	await assertOwnedEntity(user.id, input.entityId);
	await assertOwnedRefs(
		user.id,
		input as { categoryId?: string | null; paymentMethodId?: string | null },
	);
	const externalOrderId =
		input.externalOrderId || `MAN-${Date.now().toString(36).toUpperCase()}`;
	const orderId = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(orders)
			.values({
				ownerId: user.id,
				source: "generic",
				externalOrderId,
				merchantName: input.merchantName,
				orderDate: input.orderDate,
				currency: input.currency,
				totalMinor: toMinor(input.total),
				taxMinor: toMinor(input.tax),
				shippingMinor: toMinor(input.shipping),
				entityId: input.entityId ?? null,
				categoryId: input.categoryId ?? null,
				paymentMethodId: input.paymentMethodId ?? null,
				notes: input.notes ?? null,
				status: "placed",
				itemsText: input.items.map((item) => item.title).join(" · "),
			})
			.returning({ id: orders.id });
		if (!row) throw new Error("Insert failed");
		if (input.items.length)
			await tx.insert(orderItems).values(
				input.items.map((item, position) => ({
					orderId: row.id,
					position,
					title: item.title,
					quantity: item.quantity,
					totalMinor: toMinor(item.total),
				})),
			);
		await recomputeAllocations(tx, row.id);
		await audit(
			tx,
			{ type: "user", id: user.id },
			"order.created_manually",
			row.id,
		);
		return row.id;
	});
	return { id: orderId };
}

/* ───────────────────────── reimbursements ───────────────────────── */

export async function setReimbursementStatus(
	input: z.output<typeof reimbursementStatusInput>,
) {
	return setReimbursementStatusForOwner((await requireUser()).id, input);
}

export async function setReimbursementStatusForOwner(
	ownerId: string,
	input: z.output<typeof reimbursementStatusInput>,
) {
	const user = { id: ownerId };
	const owned = await db
		.select({ id: allocations.id, orderId: allocations.orderId })
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(
			and(
				eq(orders.ownerId, user.id),
				inArray(allocations.id, input.allocationIds),
			),
		);
	await db.transaction(async (tx) => {
		for (const row of owned) {
			await tx
				.update(allocations)
				.set({
					reimbursementStatus: input.status,
					...(input.status === "none"
						? { reimbursable: false }
						: { reimbursable: true }),
					updatedAt: new Date(),
				})
				.where(eq(allocations.id, row.id));
			await audit(
				tx,
				{ type: "user", id: user.id },
				"order.reimbursement",
				row.orderId,
				{
					allocationId: row.id,
					status: input.status,
				},
			);
		}
	});
	return { updated: owned.length };
}

export async function getReimbursements() {
	return getReimbursementsForOwner((await requireUser()).id);
}

export async function getReimbursementsForOwner(ownerId: string) {
	const user = { id: ownerId };
	const open = await db
		.select({
			id: allocations.id,
			orderId: allocations.orderId,
			entityId: allocations.entityId,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
			reimbursementStatus: allocations.reimbursementStatus,
			claimId: allocations.claimId,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			source: orders.source,
			orderDate: orders.orderDate,
			payingEntityId: paymentMethods.payingEntityId,
			paymentLabel: paymentMethods.label,
			documentCount:
				sql<number>`(select count(*) from ${documents} d where (d.order_id = "orders"."id" or exists (select 1 from document_links l where l.document_id = d.id and l.order_id = "orders"."id")) and d.kind in ('invoice','receipt'))`.mapWith(
					Number,
				),
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.leftJoin(paymentMethods, eq(paymentMethods.id, orders.paymentMethodId))
		.where(
			and(
				eq(orders.ownerId, user.id),
				eq(allocations.reimbursable, true),
				inArray(allocations.reimbursementStatus, [
					"pending",
					"submitted",
					"rejected",
				]),
			),
		)
		.orderBy(asc(orders.orderDate));
	const claimRows = await db
		.select()
		.from(claims)
		.where(eq(claims.ownerId, user.id))
		.orderBy(desc(claims.createdAt))
		.limit(100);
	return {
		open,
		claims: claimRows.map((claim) => ({
			...claim,
			createdAt: claim.createdAt.toISOString(),
			submittedAt: claim.submittedAt?.toISOString() ?? null,
			paidAt: claim.paidAt?.toISOString() ?? null,
		})),
	};
}

export async function createClaim(input: z.output<typeof createClaimInput>) {
	return createClaimForOwner((await requireUser()).id, input);
}

export async function createClaimForOwner(
	ownerId: string,
	input: z.output<typeof createClaimInput>,
) {
	const user = { id: ownerId };
	const candidateRows = await db
		.select({
			id: allocations.id,
			orderId: allocations.orderId,
			entityId: allocations.entityId,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
			payingEntityId: paymentMethods.payingEntityId,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.leftJoin(paymentMethods, eq(paymentMethods.id, orders.paymentMethodId))
		.where(
			and(
				eq(orders.ownerId, user.id),
				inArray(allocations.id, input.allocationIds),
				// Never claim the same allocation twice.
				isNull(allocations.claimId),
				eq(allocations.reimbursable, true),
				inArray(allocations.reimbursementStatus, ["pending", "rejected"]),
			),
		);
	// Refunds reduce what can be claimed; fully refunded/cancelled items drop out.
	const decisions = await claimableAllocationsForOwner(
		user.id,
		candidateRows.map((row) => row.id),
	);
	const rows = candidateRows.flatMap((row) => {
		const decision = decisions.get(row.id);
		if (decision && !decision.claimable) return [];
		return [{ ...row, amountMinor: decision?.claimMinor ?? row.amountMinor }];
	});
	if (rows.length === 0) throw new Error("Nothing to claim");
	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		if (!row.payingEntityId)
			throw new Error(
				"Some orders have no paying entity. Map their payment method to an entity first.",
			);
		const key = `${row.payingEntityId}|${row.entityId}|${row.currency}`;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const created: string[] = [];
	await db.transaction(async (tx) => {
		for (const [key, group] of groups) {
			const [payerEntityId, owingEntityId, currency] = key.split("|") as [
				string,
				string,
				string,
			];
			const [claim] = await tx
				.insert(claims)
				.values({
					ownerId: user.id,
					payerEntityId,
					owingEntityId,
					currency,
					status: "submitted",
					submittedAt: new Date(),
					totalMinor: group.reduce((sum, row) => sum + row.amountMinor, 0),
					reference: input.reference ?? null,
					notes: input.notes ?? null,
				})
				.returning({ id: claims.id });
			if (!claim) throw new Error("Claim insert failed");
			created.push(claim.id);
			for (const row of group) {
				await tx
					.update(allocations)
					.set({
						claimId: claim.id,
						reimbursementStatus: "submitted",
						updatedAt: new Date(),
					})
					.where(eq(allocations.id, row.id));
				await audit(
					tx,
					{ type: "user", id: user.id },
					"order.claim_created",
					row.orderId,
					{
						claimId: claim.id,
					},
				);
			}
		}
	});
	void afterClaims(user.id, created);
	return { claimIds: created };
}

export async function setClaimStatus(input: z.output<typeof claimStatusInput>) {
	return setClaimStatusForOwner((await requireUser()).id, input);
}

export async function setClaimStatusForOwner(
	ownerId: string,
	input: z.output<typeof claimStatusInput>,
) {
	const user = { id: ownerId };
	const allocationStatus =
		input.status === "paid"
			? "reimbursed"
			: input.status === "void"
				? "pending"
				: "submitted";
	await db.transaction(async (tx) => {
		const [claim] = await tx
			.select({ id: claims.id, status: claims.status })
			.from(claims)
			.where(and(eq(claims.id, input.id), eq(claims.ownerId, user.id)))
			.for("update");
		if (!claim) throw new Error("NOT_FOUND");
		const linked = await tx
			.select({ id: allocations.id, orderId: allocations.orderId })
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(
				and(eq(allocations.claimId, claim.id), eq(orders.ownerId, user.id)),
			)
			.for("update", { of: allocations });
		await tx
			.update(claims)
			.set({
				status: input.status,
				...(input.reference !== undefined
					? { reference: input.reference }
					: {}),
				paidAt: input.status === "paid" ? new Date() : null,
				...(input.status === "submitted" ? { submittedAt: new Date() } : {}),
			})
			.where(and(eq(claims.id, claim.id), eq(claims.ownerId, user.id)));
		if (linked.length > 0)
			await tx
				.update(allocations)
				.set({
					reimbursementStatus: allocationStatus,
					...(input.status === "void" ? { claimId: null } : {}),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(allocations.claimId, claim.id),
						inArray(
							allocations.id,
							linked.map((row) => row.id),
						),
						inArray(
							allocations.orderId,
							tx
								.select({ id: orders.id })
								.from(orders)
								.where(eq(orders.ownerId, user.id)),
						),
					),
				);
		await appendAuditEvent(tx, {
			actor: createAuditActor("user", user.id),
			action: "claim.status_changed",
			subject: createAuditSubject("claim", claim.id),
			outcome: "success",
			metadata: {
				previousStatus: claim.status,
				status: input.status,
				reimbursementStatus: allocationStatus,
				allocationCount: linked.length,
			},
		});
		for (const row of linked) {
			await audit(
				tx,
				{ type: "user", id: user.id },
				"order.claim_status_changed",
				row.orderId,
				{
					claimId: claim.id,
					allocationId: row.id,
					status: input.status,
					reimbursementStatus: allocationStatus,
				},
			);
		}
	});
	if (input.status === "paid") void emitClaimPaid(user.id, input.id);
	return { ok: true };
}

export async function getClaim(claimId: string) {
	return getClaimForOwner((await requireUser()).id, claimId);
}

export async function getClaimForOwner(ownerId: string, claimId: string) {
	const user = { id: ownerId };
	const [claim] = await db
		.select()
		.from(claims)
		.where(and(eq(claims.id, claimId), eq(claims.ownerId, user.id)));
	if (!claim) throw new Error("NOT_FOUND");
	const lines = await db
		.select({
			allocationId: allocations.id,
			orderId: orders.id,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			source: orders.source,
			orderDate: orders.orderDate,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(eq(allocations.claimId, claim.id))
		.orderBy(asc(orders.orderDate));
	return {
		claim: {
			...claim,
			createdAt: claim.createdAt.toISOString(),
			submittedAt: claim.submittedAt?.toISOString() ?? null,
			paidAt: claim.paidAt?.toISOString() ?? null,
		},
		lines,
	};
}

/* ───────────────────────── settings ───────────────────────── */

export async function saveEntity(input: z.output<typeof entityInput>) {
	return saveEntityForOwner((await requireUser()).id, input);
}

export async function saveEntityForOwner(
	ownerId: string,
	input: z.output<typeof entityInput>,
) {
	const user = { id: ownerId };
	const values = {
		name: input.name,
		shortName: input.shortName ?? null,
		kind: input.kind,
		color: input.color,
		isDefault: input.isDefault ?? false,
		sort: input.sort ?? 0,
		archivedAt: input.archived ? new Date() : null,
		updatedAt: new Date(),
	};
	return db.transaction(async (tx) => {
		if (values.isDefault)
			await tx
				.update(entities)
				.set({ isDefault: false })
				.where(eq(entities.ownerId, user.id));
		if (input.id) {
			const [row] = await tx
				.update(entities)
				.set(values)
				.where(and(eq(entities.id, input.id), eq(entities.ownerId, user.id)))
				.returning({ id: entities.id });
			if (!row) throw new Error("NOT_FOUND");
			return row;
		}
		const [row] = await tx
			.insert(entities)
			.values({ ...values, ownerId: user.id })
			.returning({ id: entities.id });
		return row;
	});
}

export async function saveCategory(input: z.output<typeof categoryInput>) {
	return saveCategoryForOwner((await requireUser()).id, input);
}

export async function saveCategoryForOwner(
	ownerId: string,
	input: z.output<typeof categoryInput>,
) {
	const user = { id: ownerId };
	await assertOwnedEntity(user.id, input.entityId);
	await assertOwnedRefs(
		user.id,
		input as { categoryId?: string | null; paymentMethodId?: string | null },
	);
	const values = {
		name: input.name,
		code: input.code ?? null,
		entityId: input.entityId ?? null,
		archivedAt: input.archived ? new Date() : null,
	};
	if (input.id) {
		const [row] = await db
			.update(categories)
			.set(values)
			.where(and(eq(categories.id, input.id), eq(categories.ownerId, user.id)))
			.returning({ id: categories.id });
		if (!row) throw new Error("NOT_FOUND");
		return row;
	}
	const [row] = await db
		.insert(categories)
		.values({ ...values, ownerId: user.id })
		.returning({ id: categories.id });
	return row;
}

export async function savePaymentMethod(
	input: z.output<typeof paymentMethodInput>,
) {
	return savePaymentMethodForOwner((await requireUser()).id, input);
}

export async function savePaymentMethodForOwner(
	ownerId: string,
	input: z.output<typeof paymentMethodInput>,
) {
	const user = { id: ownerId };
	await assertOwnedEntity(user.id, input.payingEntityId);
	const values = {
		label: input.label,
		...(input.brand !== undefined ? { brand: input.brand } : {}),
		...(input.last4 !== undefined ? { last4: input.last4 } : {}),
		payingEntityId: input.payingEntityId ?? null,
		archivedAt: input.archived ? new Date() : null,
	};
	const id = await db.transaction(async (tx) => {
		let methodId: string;
		if (input.id) {
			const [row] = await tx
				.update(paymentMethods)
				.set(values)
				.where(
					and(
						eq(paymentMethods.id, input.id),
						eq(paymentMethods.ownerId, user.id),
					),
				)
				.returning({ id: paymentMethods.id });
			if (!row) throw new Error("NOT_FOUND");
			methodId = row.id;
		} else {
			const [row] = await tx
				.insert(paymentMethods)
				.values({ ...values, ownerId: user.id })
				.returning({ id: paymentMethods.id });
			if (!row) throw new Error("Insert failed");
			methodId = row.id;
		}
		// Paying entity drives reimbursement: refresh affected orders.
		const affected = await tx
			.select({ id: orders.id })
			.from(orders)
			.where(eq(orders.paymentMethodId, methodId));
		for (const order of affected) await recomputeAllocations(tx, order.id);
		return methodId;
	});
	return { id };
}

/* ───────────────────────── rules ───────────────────────── */

export async function listRules() {
	return listRulesForOwner((await requireUser()).id);
}

export async function listRulesForOwner(ownerId: string) {
	const user = { id: ownerId };
	const rows = await db
		.select()
		.from(rules)
		.where(eq(rules.ownerId, user.id))
		.orderBy(asc(rules.priority), asc(rules.createdAt));
	return rows.map((rule) => ({
		...rule,
		createdAt: rule.createdAt.toISOString(),
		updatedAt: rule.updatedAt.toISOString(),
		lastMatchedAt: rule.lastMatchedAt?.toISOString() ?? null,
	}));
}

export async function saveRule(input: z.output<typeof ruleInput>) {
	return saveRuleForOwner((await requireUser()).id, input);
}

export async function saveRuleForOwner(
	ownerId: string,
	input: z.output<typeof ruleInput>,
) {
	const user = { id: ownerId };
	await assertOwnedEntity(user.id, input.actions.entityId);
	await assertOwnedRefs(user.id, { categoryId: input.actions.categoryId });
	const values = {
		name: input.name,
		enabled: input.enabled,
		priority: input.priority,
		match: input.match,
		conditions: input.conditions,
		actions: input.actions,
		updatedAt: new Date(),
	};
	if (input.id) {
		const [row] = await db
			.update(rules)
			.set(values)
			.where(and(eq(rules.id, input.id), eq(rules.ownerId, user.id)))
			.returning({ id: rules.id });
		if (!row) throw new Error("NOT_FOUND");
		return row;
	}
	const [row] = await db
		.insert(rules)
		.values({ ...values, ownerId: user.id })
		.returning({ id: rules.id });
	return row;
}

export async function deleteRule(ruleId: string) {
	return deleteRuleForOwner((await requireUser()).id, ruleId);
}

export async function deleteRuleForOwner(ownerId: string, ruleId: string) {
	const user = { id: ownerId };
	await db
		.delete(rules)
		.where(and(eq(rules.id, ruleId), eq(rules.ownerId, user.id)));
	return { ok: true };
}

/** Which of the most recent orders a draft rule would match. */
export async function dryRunRule(input: z.output<typeof ruleInput>) {
	return dryRunRuleForOwner((await requireUser()).id, input);
}

export async function dryRunRuleForOwner(
	ownerId: string,
	input: z.output<typeof ruleInput>,
) {
	const user = { id: ownerId };
	const recent = await db
		.select({
			id: orders.id,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			source: orders.source,
			orderDate: orders.orderDate,
			totalMinor: orders.totalMinor,
			currency: orders.currency,
		})
		.from(orders)
		.where(eq(orders.ownerId, user.id))
		.orderBy(desc(orders.lastCapturedAt))
		.limit(300);
	const draft = { id: input.id ?? "draft", ...input };
	const matches: typeof recent = [];
	for (const order of recent) {
		const subject = await loadRuleSubject(db, ownerId, order.id);
		if (subject && ruleMatches(draft, subject)) matches.push(order);
	}
	return {
		scanned: recent.length,
		matches: matches.slice(0, 50),
		matchCount: matches.length,
	};
}

export async function runRulesOnInbox() {
	return runRulesOnInboxForOwner((await requireUser()).id);
}

export async function runRulesOnInboxForOwner(ownerId: string) {
	const user = { id: ownerId };
	return applyRulesToInbox(user.id);
}

/** Explain which rules would fire for one order (inspector hint). */
export async function explainRules(orderId: string) {
	return explainRulesForOwner((await requireUser()).id, orderId);
}

export async function explainRulesForOwner(ownerId: string, orderId: string) {
	const user = { id: ownerId };
	await ownedOrder(user.id, orderId);
	const subject = await loadRuleSubject(db, ownerId, orderId);
	const active = await db
		.select()
		.from(rules)
		.where(and(eq(rules.ownerId, user.id), eq(rules.enabled, true)));
	return subject
		? evaluateRules(active, subject)
		: { actions: {}, matchedRuleIds: [] };
}

/* ───────────────────────── captures ───────────────────────── */

export async function listCaptures(input: z.output<typeof captureListInput>) {
	return listCapturesForOwner((await requireUser()).id, input);
}

export async function listCapturesForOwner(
	ownerId: string,
	input: z.output<typeof captureListInput>,
) {
	const user = { id: ownerId };
	const where: SQL[] = [eq(captures.ownerId, user.id)];
	if (input.status) where.push(eq(captures.status, input.status));
	if (input.source) where.push(eq(captures.source, input.source));
	const rows = await db
		.select({
			id: captures.id,
			source: captures.source,
			kind: captures.kind,
			trigger: captures.trigger,
			pageType: captures.pageType,
			pageUrl: captures.pageUrl,
			pageTitle: captures.pageTitle,
			capturedAt: captures.capturedAt,
			receivedAt: captures.receivedAt,
			status: captures.status,
			parserId: captures.parserId,
			parserVersion: captures.parserVersion,
			ordersFound: captures.ordersFound,
			error: captures.error,
			sizeBytes:
				sql<number>`coalesce(octet_length(${captures.bodyText}), 0) + coalesce(octet_length(${captures.bodyJson}::text), 0)`.mapWith(
					Number,
				),
			total: sql<number>`count(*) over()`.mapWith(Number),
		})
		.from(captures)
		.where(and(...where))
		.orderBy(desc(captures.receivedAt))
		.limit(input.limit)
		.offset(input.offset);
	return {
		total: rows[0]?.total ?? 0,
		captures: rows.map(({ total: _total, ...row }) => ({
			...row,
			capturedAt: row.capturedAt.toISOString(),
			receivedAt: row.receivedAt.toISOString(),
		})),
	};
}

export async function getCapture(captureId: string) {
	return getCaptureForOwner((await requireUser()).id, captureId);
}

export async function getCaptureForOwner(ownerId: string, captureId: string) {
	const user = { id: ownerId };
	let [row] = await db
		.select()
		.from(captures)
		.where(and(eq(captures.id, captureId), eq(captures.ownerId, user.id)));
	if (!row) throw new Error("NOT_FOUND");
	row = await loadCaptureBody(row);
	const linked = await db
		.select({
			id: orders.id,
			externalOrderId: orders.externalOrderId,
			source: orders.source,
		})
		.from(orderCaptures)
		.innerJoin(orders, eq(orders.id, orderCaptures.orderId))
		.where(eq(orderCaptures.captureId, captureId));
	const LIMIT = 400_000;
	const json =
		row.bodyJson == null ? null : JSON.stringify(row.bodyJson, null, 2);
	return {
		...row,
		capturedAt: row.capturedAt.toISOString(),
		receivedAt: row.receivedAt.toISOString(),
		parsedAt: row.parsedAt?.toISOString() ?? null,
		bodyJson: undefined,
		bodyText: row.bodyText ? row.bodyText.slice(0, LIMIT) : null,
		bodyJsonText: json ? json.slice(0, LIMIT) : null,
		truncated:
			(row.bodyText?.length ?? 0) > LIMIT || (json?.length ?? 0) > LIMIT,
		orders: linked,
	};
}

export async function reprocessCaptures(captureIds: string[]) {
	return reprocessCapturesForOwner((await requireUser()).id, captureIds);
}

export async function reprocessCapturesForOwner(
	ownerId: string,
	captureIds: string[],
) {
	const user = { id: ownerId };
	for (const id of captureIds.slice(0, 200)) await requeueCapture(user.id, id);
	return { queued: Math.min(captureIds.length, 200) };
}

export async function ignoreCapture(captureId: string) {
	return ignoreCaptureForOwner((await requireUser()).id, captureId);
}

export async function ignoreCaptureForOwner(
	ownerId: string,
	captureId: string,
) {
	const user = { id: ownerId };
	await db
		.update(captures)
		.set({ status: "ignored" })
		.where(and(eq(captures.id, captureId), eq(captures.ownerId, user.id)));
	return { ok: true };
}

/* ───────────────────────── documents ───────────────────────── */

export async function findOwnedDocument(ownerId: string, documentId: string) {
	const [row] = await db
		.select()
		.from(documents)
		.where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)));
	return row ?? null;
}

export async function deleteDocument(documentId: string) {
	return deleteDocumentForOwner((await requireUser()).id, documentId);
}

export async function deleteDocumentForOwner(
	ownerId: string,
	documentId: string,
) {
	const user = { id: ownerId };
	const doc = await findOwnedDocument(user.id, documentId);
	if (!doc) throw new Error("NOT_FOUND");
	await db.transaction(async (tx) => {
		await tx.delete(documents).where(eq(documents.id, doc.id));
		if (doc.orderId)
			await audit(
				tx,
				{ type: "user", id: user.id },
				"order.document_removed",
				doc.orderId,
				{
					fileName: doc.fileName,
				},
			);
	});
	// The sha256 dedupe means one row per object: remove the bytes too.
	await getApplicationStorage()
		.deleteObject(doc.storageKey)
		.catch(() => {});
	return { ok: true };
}

export async function attachDocumentToOrder(
	documentId: string,
	orderId: string | null,
) {
	return attachDocumentToOrderForOwner(
		(await requireUser()).id,
		documentId,
		orderId,
	);
}

export async function attachDocumentToOrderForOwner(
	ownerId: string,
	documentId: string,
	orderId: string | null,
) {
	const user = { id: ownerId };
	const doc = await findOwnedDocument(user.id, documentId);
	if (!doc) throw new Error("NOT_FOUND");
	if (orderId) await ownedOrder(user.id, orderId);
	await db.update(documents).set({ orderId }).where(eq(documents.id, doc.id));
	return { ok: true };
}
