/**
 * Owner-scoped operations behind the agent API (REST v1 and MCP). Delegates to
 * the ledger `*ForOwner` functions; only adds what the ledger does not expose
 * (identity summary, paging, natural-key idempotency, tag merging, structured
 * order ingestion through server captures).
 */
import { createHash } from "node:crypto";
import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	type SQL,
	sql,
} from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { user } from "#/db/schema";
import { env } from "#/env";
import { createServerCapture } from "#/features/ingress/captures.server";
import {
	readDocumentBytes,
	storeDocument,
} from "#/features/ledger/documents.server";
import {
	listConnectionsForOwner,
	queueExportsForOwner,
	testConnectionForOwner,
} from "#/features/ledger/exports.server";
import { getInsightsForOwner } from "#/features/ledger/insights.server";
import {
	attachDocumentToOrderForOwner,
	bulkUpdateOrdersForOwner,
	createClaimForOwner,
	deleteRuleForOwner,
	dryRunRuleForOwner,
	explainRulesForOwner,
	findOwnedDocument,
	getCaptureForOwner,
	getClaimForOwner,
	getOrderForOwner,
	getReimbursementsForOwner,
	ignoreCaptureForOwner,
	listCapturesForOwner,
	listOrdersForOwner,
	listRulesForOwner,
	reprocessCapturesForOwner,
	runRulesOnInboxForOwner,
	saveCategoryForOwner,
	saveEntityForOwner,
	savePaymentMethodForOwner,
	saveRuleForOwner,
	setClaimStatusForOwner,
	setReimbursementStatusForOwner,
	updateOrderForOwner,
	updateOrderItemForOwner,
} from "#/features/ledger/ledger.server";
import {
	allocations,
	captures,
	categories,
	claims,
	documents,
	entities,
	orderCaptures,
	orderItems,
	orders,
	paymentMethods,
	rules,
} from "#/features/ledger/schema";
import { describePermissionGrants } from "#/integrations/api-platform/permissions";
import type { ApiPrincipal } from "#/integrations/api-platform/principal.server";
import { ApiHttpError } from "#/integrations/api-platform/responses";
import type { DocumentKind } from "#/shared/capture";
import type {
	bulkOrdersBody,
	captureListQuery,
	categoryCreateBody,
	categoryPatchBody,
	claimListQuery,
	claimPatchBody,
	createClaimBody,
	createOrdersBody,
	entityCreateBody,
	entityPatchBody,
	insightsQuery,
	itemPatchBody,
	orderListQuery,
	orderPatchBody,
	paymentMethodCreateBody,
	paymentMethodPatchBody,
	queueExportBody,
	reimbursementBody,
	ruleBody,
	ruleDryRunBody,
	splitOrderBody,
	triageSchema,
} from "./schemas";

type Out<T extends z.ZodType> = z.output<T>;

const baseUrl = () => env.APP_BASE_URL.replace(/\/$/, "");

const notFound = () =>
	new ApiHttpError(404, "not_found", "Resource not found.");

/* ───────────────────────── identity ───────────────────────── */

export async function getMe(principal: ApiPrincipal) {
	const ownerId = principal.userId;
	const [[owner], entityRows, categoryRows, methodRows, inbox, attention] =
		await Promise.all([
			db
				.select({ id: user.id, name: user.name, email: user.email })
				.from(user)
				.where(eq(user.id, ownerId)),
			listEntities(ownerId, { includeArchived: false }),
			listCategories(ownerId, { includeArchived: false }),
			listPaymentMethods(ownerId, { includeArchived: false }),
			db
				.select({ n: count() })
				.from(orders)
				.where(
					and(eq(orders.ownerId, ownerId), eq(orders.reviewState, "inbox")),
				),
			db
				.select({ n: count() })
				.from(captures)
				.where(
					and(
						eq(captures.ownerId, ownerId),
						inArray(captures.status, ["failed", "needs_review"]),
					),
				),
		]);
	return {
		user: {
			id: ownerId,
			name: owner?.name ?? "",
			email: owner?.email ?? "",
		},
		key: {
			id: principal.keyId,
			permissions: principal.permissions,
			grants: describePermissionGrants(principal.permissions),
		},
		entities: entityRows.entities,
		categories: categoryRows.categories,
		paymentMethods: methodRows.paymentMethods,
		counts: {
			inbox: inbox[0]?.n ?? 0,
			capturesNeedingAttention: attention[0]?.n ?? 0,
		},
		links: {
			openapi: `${baseUrl()}/api/openapi.json`,
			docs: `${baseUrl()}/docs/api`,
			mcp: `${baseUrl()}/api/mcp`,
			app: `${baseUrl()}/app`,
		},
	};
}

/* ───────────────────────── orders ───────────────────────── */

export async function listOrders(
	ownerId: string,
	input: Out<typeof orderListQuery>,
) {
	const result = await listOrdersForOwner(ownerId, input);
	return {
		total: result.total,
		limit: input.limit,
		offset: input.offset,
		orders: result.orders,
	};
}

export async function getOrder(ownerId: string, orderId: string) {
	const detail = await getOrderForOwner(ownerId, orderId);
	return {
		...detail,
		order: { ...detail.order, url: `${baseUrl()}/app/orders/${orderId}` },
	};
}

async function orderTags(ownerId: string, orderId: string) {
	const [row] = await db
		.select({ tags: orders.tags })
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!row) throw notFound();
	return row.tags;
}

export async function updateOrder(
	ownerId: string,
	orderId: string,
	input: Out<typeof orderPatchBody>,
) {
	const { addTags, removeTags, ...changes } = input;
	if (addTags?.length || removeTags?.length) {
		const base = changes.tags ?? (await orderTags(ownerId, orderId));
		const remove = new Set(removeTags ?? []);
		changes.tags = [...new Set([...base, ...(addTags ?? [])])]
			.filter((tag) => !remove.has(tag))
			.slice(0, 20);
	}
	await updateOrderForOwner(ownerId, { id: orderId, ...changes });
	return { ok: true };
}

export async function bulkUpdateOrders(
	ownerId: string,
	input: Out<typeof bulkOrdersBody>,
) {
	return bulkUpdateOrdersForOwner(ownerId, input);
}

async function assertItemOnOrder(
	ownerId: string,
	orderId: string,
	itemIds: string[],
) {
	const rows = await db
		.select({ id: orderItems.id })
		.from(orderItems)
		.innerJoin(orders, eq(orders.id, orderItems.orderId))
		.where(
			and(
				eq(orders.ownerId, ownerId),
				eq(orders.id, orderId),
				inArray(orderItems.id, itemIds),
			),
		);
	if (rows.length !== new Set(itemIds).size) throw notFound();
}

export async function updateItem(
	ownerId: string,
	orderId: string,
	itemId: string,
	input: Out<typeof itemPatchBody>,
) {
	await assertItemOnOrder(ownerId, orderId, [itemId]);
	await updateOrderItemForOwner(ownerId, { itemId, ...input });
	return { ok: true };
}

export async function splitOrder(
	ownerId: string,
	orderId: string,
	input: Out<typeof splitOrderBody>,
) {
	await assertItemOnOrder(
		ownerId,
		orderId,
		input.items.map((item) => item.itemId),
	);
	for (const item of input.items) await updateOrderItemForOwner(ownerId, item);
	const detail = await getOrderForOwner(ownerId, orderId);
	return { updated: input.items.length, allocations: detail.allocations };
}

/* ── structured order ingestion (captures channel "agent") ── */

function slug(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "unknown"
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

async function waitForCaptures(captureIds: string[], timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const rows = await db
			.select({
				id: captures.id,
				status: captures.status,
				error: captures.error,
			})
			.from(captures)
			.where(inArray(captures.id, captureIds));
		const done = rows.every((row) => row.status !== "pending");
		if (done || Date.now() >= deadline) return rows;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

export async function createOrders(
	ownerId: string,
	input: Out<typeof createOrdersBody>,
	idempotencyKey: string | null,
	options: { waitMs?: number } = {},
) {
	const submitted: Array<{
		index: number;
		externalOrderId: string;
		captureId: string;
		duplicate: boolean;
		triage: Out<typeof triageSchema> | undefined;
	}> = [];
	for (const [index, { triage, ...order }] of input.orders.entries()) {
		const sourceRef = idempotencyKey
			? `idem:${idempotencyKey}#${index}`
			: `hash:${createHash("sha256")
					.update(stableJson({ source: input.source, order }))
					.digest("hex")}`;
		const pageUrl =
			order.orderUrl ?? `agent://${slug(order.merchantName ?? "unknown")}/`;
		const { captureId, created } = await createServerCapture({
			ownerId,
			channel: "agent",
			sourceRef,
			source: input.source,
			kind: "agent",
			pageType: "order_detail",
			pageUrl,
			pageTitle: order.merchantName
				? `${order.merchantName} order ${order.externalOrderId}`
				: `Order ${order.externalOrderId}`,
			bodyJson: { orders: [order] },
			note: input.note ?? null,
			orderIdHints: [order.externalOrderId],
		});
		submitted.push({
			index,
			externalOrderId: order.externalOrderId,
			captureId,
			duplicate: !created,
			triage,
		});
	}

	const captureIds = submitted.map((row) => row.captureId);
	const statuses = input.wait
		? await waitForCaptures(captureIds, options.waitMs ?? 10_000)
		: await waitForCaptures(captureIds, 0);
	const statusById = new Map(statuses.map((row) => [row.id, row]));
	const links = await db
		.select({
			captureId: orderCaptures.captureId,
			orderId: orderCaptures.orderId,
		})
		.from(orderCaptures)
		.innerJoin(orders, eq(orders.id, orderCaptures.orderId))
		.where(
			and(
				eq(orders.ownerId, ownerId),
				inArray(orderCaptures.captureId, captureIds),
			),
		);
	const orderByCapture = new Map(
		links.map((row) => [row.captureId, row.orderId]),
	);

	const results = [];
	for (const row of submitted) {
		const status = statusById.get(row.captureId);
		const orderId = orderByCapture.get(row.captureId) ?? null;
		let triageApplied = false;
		let error = status?.error ?? null;
		if (orderId && row.triage && Object.keys(row.triage).length) {
			try {
				await updateOrderForOwner(ownerId, { id: orderId, ...row.triage });
				triageApplied = true;
			} catch (cause) {
				error = cause instanceof Error ? cause.message : "Triage failed";
			}
		}
		results.push({
			index: row.index,
			externalOrderId: row.externalOrderId,
			captureId: row.captureId,
			duplicate: row.duplicate,
			captureStatus: status?.status ?? "pending",
			orderId,
			triageApplied,
			error,
		});
	}
	return {
		pending: results.some((row) => row.captureStatus === "pending"),
		results,
	};
}

/* ───────────────────────── reimbursements & claims ───────────────────────── */

export async function setReimbursement(
	ownerId: string,
	input: Out<typeof reimbursementBody>,
) {
	return setReimbursementStatusForOwner(ownerId, input);
}

export async function getReimbursements(ownerId: string) {
	return getReimbursementsForOwner(ownerId);
}

export async function listClaims(
	ownerId: string,
	input: Out<typeof claimListQuery>,
) {
	const where: SQL[] = [eq(claims.ownerId, ownerId)];
	if (input.status) where.push(eq(claims.status, input.status));
	const rows = await db
		.select({
			claim: claims,
			allocationCount:
				sql<number>`(select count(*) from ${allocations} a where a.claim_id = "claims"."id")`.mapWith(
					Number,
				),
			total: sql<number>`count(*) over()`.mapWith(Number),
		})
		.from(claims)
		.where(and(...where))
		.orderBy(desc(claims.createdAt))
		.limit(input.limit)
		.offset(input.offset);
	return {
		total: rows[0]?.total ?? 0,
		limit: input.limit,
		offset: input.offset,
		claims: rows.map(({ claim, allocationCount }) => ({
			...claim,
			allocationCount,
			createdAt: claim.createdAt.toISOString(),
			submittedAt: claim.submittedAt?.toISOString() ?? null,
			paidAt: claim.paidAt?.toISOString() ?? null,
		})),
	};
}

export async function getClaim(ownerId: string, claimId: string) {
	return getClaimForOwner(ownerId, claimId);
}

/** Natural idempotency: allocations already on a claim return that claim. */
export async function createClaim(
	ownerId: string,
	input: Out<typeof createClaimBody>,
) {
	const rows = await db
		.select({ id: allocations.id, claimId: allocations.claimId })
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(
			and(
				eq(orders.ownerId, ownerId),
				inArray(allocations.id, input.allocationIds),
			),
		);
	if (rows.length === 0) throw notFound();
	const claimed = rows.filter((row) => row.claimId);
	if (claimed.length === rows.length)
		return {
			claimIds: [...new Set(claimed.map((row) => row.claimId as string))],
			created: false,
		};
	const result = await createClaimForOwner(ownerId, input);
	return { ...result, created: true };
}

export async function setClaimStatus(
	ownerId: string,
	claimId: string,
	input: Out<typeof claimPatchBody>,
) {
	return setClaimStatusForOwner(ownerId, { id: claimId, ...input });
}

/* ───────────────────────── settings ───────────────────────── */

const iso = (value: Date | null) => value?.toISOString() ?? null;

export async function listEntities(
	ownerId: string,
	input: { includeArchived?: boolean },
) {
	const where: SQL[] = [eq(entities.ownerId, ownerId)];
	if (!input.includeArchived) where.push(isNull(entities.archivedAt));
	const rows = await db
		.select()
		.from(entities)
		.where(and(...where))
		.orderBy(asc(entities.sort), asc(entities.name));
	return {
		entities: rows.map(({ ownerId: _owner, ...row }) => ({
			...row,
			archivedAt: iso(row.archivedAt),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		})),
	};
}

export async function listCategories(
	ownerId: string,
	input: { includeArchived?: boolean },
) {
	const where: SQL[] = [eq(categories.ownerId, ownerId)];
	if (!input.includeArchived) where.push(isNull(categories.archivedAt));
	const rows = await db
		.select()
		.from(categories)
		.where(and(...where))
		.orderBy(asc(categories.code), asc(categories.name));
	return {
		categories: rows.map(({ ownerId: _owner, ...row }) => ({
			...row,
			archivedAt: iso(row.archivedAt),
			createdAt: row.createdAt.toISOString(),
		})),
	};
}

export async function listPaymentMethods(
	ownerId: string,
	input: { includeArchived?: boolean },
) {
	const where: SQL[] = [eq(paymentMethods.ownerId, ownerId)];
	if (!input.includeArchived) where.push(isNull(paymentMethods.archivedAt));
	const rows = await db
		.select()
		.from(paymentMethods)
		.where(and(...where))
		.orderBy(asc(paymentMethods.label));
	return {
		paymentMethods: rows.map(({ ownerId: _owner, ...row }) => ({
			...row,
			archivedAt: iso(row.archivedAt),
			createdAt: row.createdAt.toISOString(),
		})),
	};
}

/** Natural key: an entity with the same name (case-insensitive) is returned. */
export async function createEntity(
	ownerId: string,
	input: Out<typeof entityCreateBody>,
) {
	const [existing] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(
			and(
				eq(entities.ownerId, ownerId),
				sql`lower(${entities.name}) = lower(${input.name})`,
			),
		);
	if (existing) return { id: existing.id, created: false };
	const row = await saveEntityForOwner(ownerId, input);
	if (!row) throw new Error("Insert failed");
	return { id: row.id, created: true };
}

export async function updateEntity(
	ownerId: string,
	entityId: string,
	input: Out<typeof entityPatchBody>,
) {
	const [row] = await db
		.select()
		.from(entities)
		.where(and(eq(entities.id, entityId), eq(entities.ownerId, ownerId)));
	if (!row) throw notFound();
	await saveEntityForOwner(ownerId, {
		id: entityId,
		name: input.name ?? row.name,
		shortName: input.shortName !== undefined ? input.shortName : row.shortName,
		kind: input.kind ?? row.kind,
		color: input.color ?? row.color,
		isDefault: input.isDefault ?? row.isDefault,
		sort: input.sort ?? row.sort,
		archived: input.archived ?? row.archivedAt !== null,
	});
	return { ok: true };
}

/** Natural key: same name within the same entity scope. */
export async function createCategory(
	ownerId: string,
	input: Out<typeof categoryCreateBody>,
) {
	const [existing] = await db
		.select({ id: categories.id })
		.from(categories)
		.where(
			and(
				eq(categories.ownerId, ownerId),
				sql`lower(${categories.name}) = lower(${input.name})`,
				input.entityId
					? eq(categories.entityId, input.entityId)
					: isNull(categories.entityId),
			),
		);
	if (existing) return { id: existing.id, created: false };
	const row = await saveCategoryForOwner(ownerId, input);
	if (!row) throw new Error("Insert failed");
	return { id: row.id, created: true };
}

export async function updateCategory(
	ownerId: string,
	categoryId: string,
	input: Out<typeof categoryPatchBody>,
) {
	const [row] = await db
		.select()
		.from(categories)
		.where(and(eq(categories.id, categoryId), eq(categories.ownerId, ownerId)));
	if (!row) throw notFound();
	await saveCategoryForOwner(ownerId, {
		id: categoryId,
		name: input.name ?? row.name,
		code: input.code !== undefined ? input.code : row.code,
		entityId: input.entityId !== undefined ? input.entityId : row.entityId,
		archived: input.archived ?? row.archivedAt !== null,
	});
	return { ok: true };
}

/** Natural key: same card (brand + last4) or, without last4, the same label. */
export async function createPaymentMethod(
	ownerId: string,
	input: Out<typeof paymentMethodCreateBody>,
) {
	const [existing] = await db
		.select({ id: paymentMethods.id })
		.from(paymentMethods)
		.where(
			and(
				eq(paymentMethods.ownerId, ownerId),
				input.last4
					? and(
							eq(paymentMethods.last4, input.last4),
							eq(paymentMethods.brand, input.brand ?? ""),
						)
					: sql`lower(${paymentMethods.label}) = lower(${input.label})`,
			),
		);
	if (existing) return { id: existing.id, created: false };
	const row = await savePaymentMethodForOwner(ownerId, input);
	return { id: row.id, created: true };
}

export async function updatePaymentMethod(
	ownerId: string,
	paymentMethodId: string,
	input: Out<typeof paymentMethodPatchBody>,
) {
	const [row] = await db
		.select()
		.from(paymentMethods)
		.where(
			and(
				eq(paymentMethods.id, paymentMethodId),
				eq(paymentMethods.ownerId, ownerId),
			),
		);
	if (!row) throw notFound();
	await savePaymentMethodForOwner(ownerId, {
		id: paymentMethodId,
		label: input.label ?? row.label,
		brand: input.brand ?? row.brand,
		last4: input.last4 ?? row.last4,
		payingEntityId:
			input.payingEntityId !== undefined
				? input.payingEntityId
				: row.payingEntityId,
		archived: input.archived ?? row.archivedAt !== null,
	});
	return { ok: true };
}

/* ───────────────────────── rules ───────────────────────── */

export async function listRules(ownerId: string) {
	return {
		rules: (await listRulesForOwner(ownerId)).map(
			({ ownerId: _owner, ...rule }) => rule,
		),
	};
}

/** Natural key: a rule with the same name is returned unchanged. */
export async function createRule(ownerId: string, input: Out<typeof ruleBody>) {
	const [existing] = await db
		.select({ id: rules.id })
		.from(rules)
		.where(
			and(
				eq(rules.ownerId, ownerId),
				sql`lower(${rules.name}) = lower(${input.name})`,
			),
		);
	if (existing) return { id: existing.id, created: false };
	const row = await saveRuleForOwner(ownerId, input);
	if (!row) throw new Error("Insert failed");
	return { id: row.id, created: true };
}

export async function replaceRule(
	ownerId: string,
	ruleId: string,
	input: Out<typeof ruleBody>,
) {
	await saveRuleForOwner(ownerId, { ...input, id: ruleId });
	return { ok: true };
}

export async function deleteRule(ownerId: string, ruleId: string) {
	const [row] = await db
		.select({ id: rules.id })
		.from(rules)
		.where(and(eq(rules.id, ruleId), eq(rules.ownerId, ownerId)));
	if (!row) throw notFound();
	return deleteRuleForOwner(ownerId, ruleId);
}

export async function dryRunRule(
	ownerId: string,
	input: Out<typeof ruleDryRunBody>,
) {
	return dryRunRuleForOwner(ownerId, input);
}

export async function applyRules(ownerId: string) {
	return runRulesOnInboxForOwner(ownerId);
}

export async function explainRules(ownerId: string, orderId: string) {
	return explainRulesForOwner(ownerId, orderId);
}

/* ───────────────────────── captures ───────────────────────── */

export async function listCaptures(
	ownerId: string,
	input: Out<typeof captureListQuery>,
) {
	if (input.channel) {
		const where: SQL[] = [
			eq(captures.ownerId, ownerId),
			eq(captures.channel, input.channel),
		];
		if (input.status) where.push(eq(captures.status, input.status));
		if (input.source) where.push(eq(captures.source, input.source));
		const rows = await db
			.select({
				id: captures.id,
				source: captures.source,
				kind: captures.kind,
				channel: captures.channel,
				sourceRef: captures.sourceRef,
				pageUrl: captures.pageUrl,
				pageTitle: captures.pageTitle,
				capturedAt: captures.capturedAt,
				receivedAt: captures.receivedAt,
				status: captures.status,
				parserId: captures.parserId,
				ordersFound: captures.ordersFound,
				error: captures.error,
				total: sql<number>`count(*) over()`.mapWith(Number),
			})
			.from(captures)
			.where(and(...where))
			.orderBy(desc(captures.receivedAt))
			.limit(input.limit)
			.offset(input.offset);
		return {
			total: rows[0]?.total ?? 0,
			limit: input.limit,
			offset: input.offset,
			captures: rows.map(({ total: _total, ...row }) => ({
				...row,
				capturedAt: row.capturedAt.toISOString(),
				receivedAt: row.receivedAt.toISOString(),
			})),
		};
	}
	const result = await listCapturesForOwner(ownerId, input);
	return {
		total: result.total,
		limit: input.limit,
		offset: input.offset,
		captures: result.captures,
	};
}

export async function getCapture(
	ownerId: string,
	captureId: string,
	includeBody: boolean,
) {
	const { ownerId: _owner, ...row } = await getCaptureForOwner(
		ownerId,
		captureId,
	);
	if (includeBody) return row;
	const { bodyText: _text, bodyJsonText: _json, ...rest } = row;
	return rest;
}

async function assertOwnedCapture(ownerId: string, captureId: string) {
	const [row] = await db
		.select({ id: captures.id })
		.from(captures)
		.where(and(eq(captures.id, captureId), eq(captures.ownerId, ownerId)));
	if (!row) throw notFound();
}

export async function reprocessCaptures(ownerId: string, captureIds: string[]) {
	return reprocessCapturesForOwner(ownerId, captureIds);
}

export async function ignoreCapture(ownerId: string, captureId: string) {
	await assertOwnedCapture(ownerId, captureId);
	return ignoreCaptureForOwner(ownerId, captureId);
}

/* ───────────────────────── documents ───────────────────────── */

async function assertOwnedOrder(ownerId: string, orderId: string) {
	const [row] = await db
		.select({ id: orders.id })
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!row) throw notFound();
}

export async function listOrderDocuments(ownerId: string, orderId: string) {
	await assertOwnedOrder(ownerId, orderId);
	const rows = await db
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
		.where(and(eq(documents.ownerId, ownerId), eq(documents.orderId, orderId)))
		.orderBy(desc(documents.createdAt));
	return {
		documents: rows.map((row) => ({
			...row,
			createdAt: row.createdAt.toISOString(),
			downloadUrl: `${baseUrl()}/api/v1/documents/${row.id}`,
		})),
	};
}

/** Stores and attaches a document; duplicates (same sha256) are re-attached when unlinked. */
export async function uploadOrderDocument(
	ownerId: string,
	orderId: string,
	file: {
		bytes: Uint8Array;
		contentType: string;
		fileName: string;
		kind: DocumentKind;
	},
) {
	await assertOwnedOrder(ownerId, orderId);
	const stored = await storeDocument({
		ownerId,
		bytes: file.bytes,
		contentType: file.contentType,
		fileName: file.fileName,
		kind: file.kind,
		orderId,
	});
	if (stored.duplicate && !stored.orderId) {
		await attachDocumentToOrderForOwner(ownerId, stored.id, orderId);
		return { documentId: stored.id, duplicate: true, orderId };
	}
	return {
		documentId: stored.id,
		duplicate: stored.duplicate,
		orderId: stored.orderId,
	};
}

export async function downloadDocument(ownerId: string, documentId: string) {
	const doc = await findOwnedDocument(ownerId, documentId);
	if (!doc) throw notFound();
	const bytes = await readDocumentBytes(doc.storageKey);
	const contentType =
		doc.contentType === "text/html"
			? "text/plain; charset=utf-8"
			: doc.contentType;
	return new Response(Buffer.from(bytes), {
		headers: {
			"content-type": contentType,
			"content-length": String(bytes.byteLength),
			"content-disposition": `attachment; filename="${doc.fileName.replace(/"/g, "")}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox",
		},
	});
}

/* ───────────────────────── exports, connections, insights ───────────────────────── */

export async function queueExport(
	ownerId: string,
	input: Out<typeof queueExportBody>,
) {
	return queueExportsForOwner(ownerId, input);
}

export async function listConnections(ownerId: string) {
	return {
		connections: (await listConnectionsForOwner(ownerId)).map(
			({ ownerId: _owner, ...row }) => row,
		),
	};
}

export async function testConnection(ownerId: string, connectionId: string) {
	return testConnectionForOwner(ownerId, connectionId);
}

export async function getInsights(
	ownerId: string,
	input: Out<typeof insightsQuery>,
) {
	return getInsightsForOwner(ownerId, input);
}
