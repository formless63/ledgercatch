/**
 * Read models for the Reimbursements, Insights and Captures pages that the
 * core ledger module does not provide. Owner-scoped like everything else.
 */
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	inArray,
	lte,
	type SQL,
	sql,
} from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { loadCaptureBody } from "#/features/ops/compaction.server";
import { requeueCapture } from "./captures.server";
import type { insightsInput } from "./inputs";
import { requireUser } from "./ledger.server";
import {
	allocations,
	captures,
	categories,
	claims,
	documents,
	entities,
	orderItems,
	orders,
	paymentMethods,
} from "./schema";

/* ───────────────────────── claims ───────────────────────── */

/** Line counts per claim (for the claims list). */
export async function getClaimStats() {
	return getClaimStatsForOwner((await requireUser()).id);
}

export async function getClaimStatsForOwner(ownerId: string) {
	const user = { id: ownerId };
	const rows = await db
		.select({
			claimId: allocations.claimId,
			lines: count(),
			missingInvoices:
				sql<number>`count(*) filter (where not exists (select 1 from ${documents} d where (d.order_id = "orders"."id" or exists (select 1 from document_links l where l.document_id = d.id and l.order_id = "orders"."id")) and d.kind in ('invoice','receipt')))`.mapWith(
					Number,
				),
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.innerJoin(claims, eq(claims.id, allocations.claimId))
		.where(and(eq(orders.ownerId, user.id), eq(claims.ownerId, user.id)))
		.groupBy(allocations.claimId);
	return rows.flatMap((row) =>
		row.claimId
			? [
					{
						claimId: row.claimId,
						lines: row.lines,
						missingInvoices: row.missingInvoices,
					},
				]
			: [],
	);
}

/** Everything needed for a printable expense report of one claim. */
export async function getClaimReport(claimId: string) {
	return getClaimReportForOwner((await requireUser()).id, claimId);
}

export async function getClaimReportForOwner(ownerId: string, claimId: string) {
	const user = { id: ownerId };
	const [claim] = await db
		.select()
		.from(claims)
		.where(and(eq(claims.id, claimId), eq(claims.ownerId, user.id)));
	if (!claim) throw new Error("NOT_FOUND");
	const entityRows = await db
		.select({
			id: entities.id,
			name: entities.name,
			shortName: entities.shortName,
			color: entities.color,
		})
		.from(entities)
		.where(
			and(
				eq(entities.ownerId, user.id),
				inArray(entities.id, [claim.payerEntityId, claim.owingEntityId]),
			),
		);
	const lines = await db
		.select({
			allocationId: allocations.id,
			entityId: allocations.entityId,
			amountMinor: allocations.amountMinor,
			currency: allocations.currency,
			reimbursementStatus: allocations.reimbursementStatus,
			categoryName: categories.name,
			categoryCode: categories.code,
			orderId: orders.id,
			primaryEntityId: orders.entityId,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			source: orders.source,
			orderDate: orders.orderDate,
			orderTotalMinor: orders.totalMinor,
			orderTaxMinor: orders.taxMinor,
			paymentLabel: paymentMethods.label,
			paymentLast4: paymentMethods.last4,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.leftJoin(categories, eq(categories.id, allocations.categoryId))
		.leftJoin(paymentMethods, eq(paymentMethods.id, orders.paymentMethodId))
		.where(and(eq(allocations.claimId, claim.id), eq(orders.ownerId, user.id)))
		.orderBy(asc(orders.orderDate));
	const orderIds = [...new Set(lines.map((line) => line.orderId))];
	const [items, docs] = orderIds.length
		? await Promise.all([
				db
					.select({
						orderId: orderItems.orderId,
						title: orderItems.title,
						quantity: orderItems.quantity,
						totalMinor: orderItems.totalMinor,
						entityId: orderItems.entityId,
					})
					.from(orderItems)
					.where(inArray(orderItems.orderId, orderIds))
					.orderBy(asc(orderItems.position)),
				db
					.select({
						id: documents.id,
						orderId: documents.orderId,
						kind: documents.kind,
						fileName: documents.fileName,
					})
					.from(documents)
					.where(
						and(
							eq(documents.ownerId, user.id),
							inArray(documents.orderId, orderIds),
							inArray(documents.kind, ["invoice", "receipt"]),
						),
					),
			])
		: [[], []];
	return {
		claim: {
			...claim,
			createdAt: claim.createdAt.toISOString(),
			submittedAt: claim.submittedAt?.toISOString() ?? null,
			paidAt: claim.paidAt?.toISOString() ?? null,
		},
		payer: entityRows.find((e) => e.id === claim.payerEntityId) ?? null,
		owing: entityRows.find((e) => e.id === claim.owingEntityId) ?? null,
		lines: lines.map((line) => ({
			...line,
			items: items
				.filter(
					(item) =>
						item.orderId === line.orderId &&
						(item.entityId ?? line.primaryEntityId) === line.entityId,
				)
				.map(({ orderId: _o, entityId: _e, ...item }) => item),
			documents: docs
				.filter((doc) => doc.orderId === line.orderId)
				.map(({ orderId: _o, ...doc }) => doc),
		})),
	};
}
export type ClaimReport = Awaited<ReturnType<typeof getClaimReport>>;

/* ───────────────────────── insights ───────────────────────── */

/**
 * Entity-aware complements to getInsights: when an entity filter is set,
 * spend by store and order counts come from that entity's allocations.
 */
export async function getInsightsSupplement(
	input: z.output<typeof insightsInput>,
) {
	return getInsightsSupplementForOwner((await requireUser()).id, input);
}

export async function getInsightsSupplementForOwner(
	ownerId: string,
	input: z.output<typeof insightsInput>,
) {
	const user = { id: ownerId };
	const to = input.to ?? new Date().toISOString().slice(0, 10);
	const from =
		input.from ??
		new Date(new Date(to).getTime() - 365 * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const where: SQL[] = [
		eq(orders.ownerId, user.id),
		gte(orders.orderDate, from),
		lte(orders.orderDate, to),
		sql`${orders.reviewState} <> 'ignored'`,
		sql`${orders.status} <> 'cancelled'`,
	];
	if (input.entityId) where.push(eq(allocations.entityId, input.entityId));
	const missingInvoice = sql`not exists (select 1 from ${documents} d where (d.order_id = "orders"."id" or exists (select 1 from document_links l where l.document_id = d.id and l.order_id = "orders"."id")) and d.kind in ('invoice','receipt'))`;
	const [bySource, totals] = await Promise.all([
		db
			.select({
				source: orders.source,
				currency: allocations.currency,
				amountMinor:
					sql<number>`coalesce(sum(${allocations.amountMinor}), 0)::bigint`.mapWith(
						Number,
					),
				orders: sql<number>`count(distinct ${orders.id})`.mapWith(Number),
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(...where))
			.groupBy(orders.source, allocations.currency),
		db
			.select({
				currency: allocations.currency,
				amountMinor:
					sql<number>`coalesce(sum(${allocations.amountMinor}), 0)::bigint`.mapWith(
						Number,
					),
				orders: sql<number>`count(distinct ${orders.id})`.mapWith(Number),
				missingInvoices:
					sql<number>`count(distinct ${orders.id}) filter (where ${missingInvoice})`.mapWith(
						Number,
					),
			})
			.from(allocations)
			.innerJoin(orders, eq(orders.id, allocations.orderId))
			.where(and(...where))
			.groupBy(allocations.currency),
	]);
	return { bySource, totals };
}

/* ───────────────────────── captures ───────────────────────── */

/** Counts per capture status and per source (for filter chips). */
export async function getCaptureFacets() {
	return getCaptureFacetsForOwner((await requireUser()).id);
}

export async function getCaptureFacetsForOwner(ownerId: string) {
	const user = { id: ownerId };
	const [byStatus, bySource] = await Promise.all([
		db
			.select({ status: captures.status, n: count() })
			.from(captures)
			.where(eq(captures.ownerId, user.id))
			.groupBy(captures.status),
		db
			.select({ source: captures.source, n: count() })
			.from(captures)
			.where(eq(captures.ownerId, user.id))
			.groupBy(captures.source),
	]);
	return { byStatus, bySource };
}

/** Re-queue every failed capture (optionally for one source), newest first. */
export async function reprocessFailedCaptures(input: {
	source?: string;
	includeNeedsReview?: boolean;
}) {
	return reprocessFailedCapturesForOwner((await requireUser()).id, input);
}

export async function reprocessFailedCapturesForOwner(
	ownerId: string,
	input: {
		source?: string;
		includeNeedsReview?: boolean;
	},
) {
	const user = { id: ownerId };
	const statuses: Array<"failed" | "needs_review"> = input.includeNeedsReview
		? ["failed", "needs_review"]
		: ["failed"];
	const where: SQL[] = [
		eq(captures.ownerId, user.id),
		inArray(captures.status, statuses),
	];
	if (input.source) where.push(eq(captures.source, input.source));
	const rows = await db
		.select({ id: captures.id })
		.from(captures)
		.where(and(...where))
		.orderBy(desc(captures.receivedAt))
		.limit(500);
	for (const row of rows) await requeueCapture(user.id, row.id);
	return { queued: rows.length };
}

/**
 * The original capture as an envelope-like object (untruncated), suitable for
 * dropping into src/features/parsing/fixtures.
 */
export async function getCaptureFixture(captureId: string) {
	return getCaptureFixtureForOwner((await requireUser()).id, captureId);
}

export async function getCaptureFixtureForOwner(
	ownerId: string,
	captureId: string,
) {
	const user = { id: ownerId };
	let [row] = await db
		.select()
		.from(captures)
		.where(and(eq(captures.id, captureId), eq(captures.ownerId, user.id)));
	if (!row) throw new Error("NOT_FOUND");
	row = await loadCaptureBody(row);
	const payload =
		row.kind === "api_json"
			? {
					type: "json" as const,
					requestUrl: row.requestUrl ?? row.pageUrl,
					body: row.bodyJson,
				}
			: row.kind === "html_snapshot"
				? { type: "html" as const, html: row.bodyText ?? "" }
				: {
						type: "text" as const,
						text: row.bodyText ?? "",
						...(row.note ? { note: row.note } : {}),
					};
	const fixture = {
		captureId: row.id,
		source: row.source,
		kind: row.kind,
		trigger: row.trigger,
		pageType: row.pageType,
		pageUrl: row.pageUrl,
		pageTitle: row.pageTitle,
		capturedAt: row.capturedAt.toISOString(),
		extensionVersion: row.extensionVersion,
		orderIdHints: row.orderIdHints,
		payload,
	};
	const fileName = `${row.source}-${row.pageType}-${row.id.slice(0, 8)}.json`;
	return { fileName, json: `${JSON.stringify(fixture, null, "\t")}\n` };
}
