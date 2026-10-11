/**
 * Assisted document review (Import → Documents): queue of document captures
 * without an order, the layout + extraction for one capture, and the actions
 * that resolve it (create order, attach to an existing order, ignore).
 * Every query is owner-scoped; the *ForOwner cores take an explicit owner.
 */
import {
	and,
	count,
	desc,
	eq,
	exists,
	ilike,
	ne,
	notExists,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { publishLedgerEvent } from "#/features/ledger/events.server";
import {
	ignoreCaptureForOwner,
	requireUser,
} from "#/features/ledger/ledger.server";
import {
	audit,
	recomputeAllocations,
	upsertParsedOrder,
} from "#/features/ledger/orders.server";
import { applyRulesToNewOrder } from "#/features/ledger/process.server";
import {
	captures,
	documents,
	orderCaptures,
	orders,
} from "#/features/ledger/schema";
import type { ParsedOrder } from "#/features/parsing/types";
import { importTemplates } from "../schema";
import {
	analyzeDocumentCapture,
	readExtraction,
	TEMPLATE_PREFIX,
} from "./analyze.server";
import {
	buildTemplate,
	decimalToMinor,
	merchantOrderUrl,
	merchantSlug,
} from "./fields";
import type {
	analyzeDocumentInput,
	attachDocumentInput,
	createOrderFromDocumentInput,
	documentQueueInput,
	searchOrdersInput,
} from "./inputs";
import { readLayout } from "./layout";
import { DOCUMENT_PARSER_VERSION } from "./parse.server";

const REVIEW_PARSER_ID = "document-review";

const orderLinks = () =>
	db
		.select({ one: sql`1` })
		.from(orderCaptures)
		.where(eq(orderCaptures.captureId, captures.id));

function viewWhere(
	ownerId: string,
	view: z.output<typeof documentQueueInput>["view"],
) {
	const base = [eq(captures.ownerId, ownerId), eq(captures.kind, "document")];
	if (view === "ignored") return and(...base, eq(captures.status, "ignored"));
	if (view === "done") return and(...base, exists(orderLinks()));
	return and(...base, ne(captures.status, "ignored"), notExists(orderLinks()));
}

const fieldValue = (key: string) =>
	sql<
		string | null
	>`${captures.bodyJson} -> 'extraction' -> 'fields' -> ${key} ->> 'value'`;

/* ───────────────────────── queue ───────────────────────── */

export async function listDocumentQueue(
	input: z.output<typeof documentQueueInput>,
) {
	return listDocumentQueueForOwner((await requireUser()).id, input);
}

export async function listDocumentQueueForOwner(
	ownerId: string,
	input: z.output<typeof documentQueueInput>,
) {
	const rows = await db
		.select({
			id: captures.id,
			status: captures.status,
			error: captures.error,
			channel: captures.channel,
			source: captures.source,
			title: captures.pageTitle,
			receivedAt: captures.receivedAt,
			documentId: captures.documentId,
			fileName: documents.fileName,
			contentType: documents.contentType,
			documentKind: documents.kind,
			sizeBytes: documents.sizeBytes,
			merchantName: fieldValue("merchantName"),
			externalOrderId: fieldValue("externalOrderId"),
			total: fieldValue("total"),
			currency: fieldValue("currency"),
			orderId: sql<
				string | null
			>`(select ${orderCaptures.orderId} from ${orderCaptures} where ${orderCaptures.captureId} = ${captures.id} limit 1)`,
		})
		.from(captures)
		.leftJoin(
			documents,
			and(
				eq(documents.id, captures.documentId),
				eq(documents.ownerId, ownerId),
			),
		)
		.where(viewWhere(ownerId, input.view))
		.orderBy(desc(captures.receivedAt))
		.limit(input.limit);
	const counts = await Promise.all(
		(["review", "done", "ignored"] as const).map(async (view) => {
			const [row] = await db
				.select({ n: count() })
				.from(captures)
				.where(viewWhere(ownerId, view));
			return [view, row?.n ?? 0] as const;
		}),
	);
	return {
		rows: rows.map((row) => ({
			...row,
			receivedAt: row.receivedAt.toISOString(),
		})),
		counts: Object.fromEntries(counts) as Record<
			"review" | "done" | "ignored",
			number
		>,
	};
}

export type DocumentQueue = Awaited<
	ReturnType<typeof listDocumentQueueForOwner>
>;
export type DocumentQueueRow = DocumentQueue["rows"][number];

/* ───────────────────────── review detail ───────────────────────── */

async function ownedCapture(ownerId: string, captureId: string) {
	const [row] = await db
		.select()
		.from(captures)
		.where(
			and(
				eq(captures.id, captureId),
				eq(captures.ownerId, ownerId),
				eq(captures.kind, "document"),
			),
		);
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

export async function getDocumentReview(captureId: string) {
	return getDocumentReviewForOwner((await requireUser()).id, captureId);
}

export async function getDocumentReviewForOwner(
	ownerId: string,
	captureId: string,
) {
	const capture = await ownedCapture(ownerId, captureId);
	const [document] = capture.documentId
		? await db
				.select({
					id: documents.id,
					fileName: documents.fileName,
					contentType: documents.contentType,
					kind: documents.kind,
					sizeBytes: documents.sizeBytes,
					orderId: documents.orderId,
				})
				.from(documents)
				.where(
					and(
						eq(documents.id, capture.documentId),
						eq(documents.ownerId, ownerId),
					),
				)
		: [];
	const linked = await db
		.select({
			id: orders.id,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
		})
		.from(orderCaptures)
		.innerJoin(orders, eq(orders.id, orderCaptures.orderId))
		.where(
			and(eq(orderCaptures.captureId, capture.id), eq(orders.ownerId, ownerId)),
		);
	return {
		capture: {
			id: capture.id,
			status: capture.status,
			error: capture.error,
			channel: capture.channel,
			source: capture.source,
			title: capture.pageTitle,
			note: capture.note,
			receivedAt: capture.receivedAt.toISOString(),
		},
		document: document ?? null,
		layout: readLayout(capture.bodyJson),
		extraction: readExtraction(capture.bodyJson),
		text: (capture.bodyText ?? "").slice(0, 50_000),
		linkedOrders: linked,
	};
}

export type DocumentReview = Awaited<
	ReturnType<typeof getDocumentReviewForOwner>
>;

/** Runs (or re-runs, with forced OCR) text extraction + field detection now. */
export async function analyzeDocument(
	input: z.output<typeof analyzeDocumentInput>,
) {
	return analyzeDocumentForOwner((await requireUser()).id, input);
}

export async function analyzeDocumentForOwner(
	ownerId: string,
	input: z.output<typeof analyzeDocumentInput>,
) {
	const capture = await ownedCapture(ownerId, input.captureId);
	await analyzeDocumentCapture(capture, { ocr: input.ocr, budgetMs: 60_000 });
	return getDocumentReviewForOwner(ownerId, input.captureId);
}

/* ───────────────────────── actions ───────────────────────── */

async function markCaptureResolved(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	captureId: string,
) {
	await tx
		.update(captures)
		.set({
			status: "parsed",
			error: null,
			parserId: REVIEW_PARSER_ID,
			parserVersion: DOCUMENT_PARSER_VERSION,
			ordersFound: 1,
			parsedAt: new Date(),
		})
		.where(eq(captures.id, captureId));
}

export async function createOrderFromDocument(
	input: z.output<typeof createOrderFromDocumentInput>,
) {
	return createOrderFromDocumentForOwner((await requireUser()).id, input);
}

export async function createOrderFromDocumentForOwner(
	ownerId: string,
	input: z.output<typeof createOrderFromDocumentInput>,
): Promise<
	| { ok: true; orderId: string; created: boolean }
	| { ok: false; existingOrderId: string; message: string }
> {
	const capture = await ownedCapture(ownerId, input.captureId);
	const { genericOrderKey } = await import("#/features/ledger/process.server");
	const source = capture.source;
	const rawId =
		input.externalOrderId?.trim() ||
		`DOC-${capture.id.slice(0, 8).toUpperCase()}`;
	const externalOrderId =
		source === "generic"
			? genericOrderKey(merchantOrderUrl(input.merchantName), rawId)
			: rawId;

	const [existing] = await db
		.select({ id: orders.id })
		.from(orders)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				eq(orders.source, source),
				eq(orders.externalOrderId, externalOrderId),
			),
		);
	if (existing)
		return {
			ok: false,
			existingOrderId: existing.id,
			message: `Order ${rawId} from ${input.merchantName} already exists — attach the document to it instead.`,
		};

	const currency = input.currency;
	const minor = (value: string | undefined) => decimalToMinor(value, currency);
	const discount = minor(input.discount);
	const parsed: ParsedOrder = {
		externalOrderId,
		merchantName: input.merchantName,
		orderDate: input.orderDate ?? capture.capturedAt.toISOString().slice(0, 10),
		status: "placed",
		currency,
		subtotalMinor: minor(input.subtotal),
		shippingMinor: minor(input.shipping),
		taxMinor: minor(input.tax),
		discountMinor: discount === undefined ? undefined : Math.abs(discount),
		totalMinor: minor(input.total),
		paymentLast4: input.paymentLast4,
		items: input.items.length
			? input.items.map((item) => ({
					title: item.title,
					quantity: item.quantity,
					unitPriceMinor: minor(item.unitPrice),
					totalMinor: minor(item.total),
				}))
			: undefined,
	};

	const orderId = await db.transaction(async (tx) => {
		const outcome = await upsertParsedOrder(
			tx,
			ownerId,
			source,
			parsed,
			capture.id,
		);
		await tx
			.update(orders)
			.set({
				...(input.entityId !== undefined ? { entityId: input.entityId } : {}),
				...(input.categoryId !== undefined
					? { categoryId: input.categoryId }
					: {}),
				...(input.notes ? { notes: input.notes } : {}),
				updatedAt: new Date(),
			})
			.where(and(eq(orders.id, outcome.orderId), eq(orders.ownerId, ownerId)));
		if (capture.documentId)
			await tx
				.update(documents)
				.set({
					orderId: outcome.orderId,
					kind: input.documentKind,
					source,
					externalOrderId,
				})
				.where(
					and(
						eq(documents.id, capture.documentId),
						eq(documents.ownerId, ownerId),
					),
				);
		await markCaptureResolved(tx, capture.id);
		// Rules fill whatever the reviewer left unset (entity is kept if chosen).
		if (outcome.created)
			await applyRulesToNewOrder(tx, ownerId, outcome.orderId);
		await recomputeAllocations(tx, outcome.orderId);
		await audit(
			tx,
			{ type: "user", id: ownerId },
			"order.created_from_document",
			outcome.orderId,
			{ captureId: capture.id, documentId: capture.documentId },
		);
		return outcome.orderId;
	});

	if (input.learn)
		await rememberTemplate(ownerId, capture.bodyJson, input).catch(() => {});
	publishLedgerEvent(ownerId, {
		type: "orders",
		orderIds: [orderId],
		created: 1,
	});
	return { ok: true, orderId, created: true };
}

/** Saves where each field was found for this merchant (import_templates). */
async function rememberTemplate(
	ownerId: string,
	bodyJson: unknown,
	input: z.output<typeof createOrderFromDocumentInput>,
) {
	const layout = readLayout(bodyJson);
	if (!layout || layout.synthetic) return;
	const refs = Object.fromEntries(
		Object.entries(input.fieldRefs).filter(
			([, list]) => list && list.length > 0,
		),
	);
	if (Object.keys(refs).length === 0) return;
	const mapping = buildTemplate(layout, input.merchantName, refs);
	if (Object.keys(mapping.fields).length === 0) return;
	const source = `${TEMPLATE_PREFIX}${merchantSlug(input.merchantName)}`;
	const [existing] = await db
		.select({ id: importTemplates.id })
		.from(importTemplates)
		.where(
			and(
				eq(importTemplates.ownerId, ownerId),
				eq(importTemplates.source, source),
			),
		);
	if (existing)
		await db
			.update(importTemplates)
			.set({ name: input.merchantName, mapping, updatedAt: new Date() })
			.where(eq(importTemplates.id, existing.id));
	else
		await db.insert(importTemplates).values({
			ownerId,
			name: input.merchantName,
			source,
			headerSignature: source,
			mapping,
			options: { kind: "document-fields" },
		});
}

export async function attachDocumentCapture(
	input: z.output<typeof attachDocumentInput>,
) {
	return attachDocumentCaptureForOwner((await requireUser()).id, input);
}

export async function attachDocumentCaptureForOwner(
	ownerId: string,
	input: z.output<typeof attachDocumentInput>,
) {
	const capture = await ownedCapture(ownerId, input.captureId);
	const [order] = await db
		.select({ id: orders.id })
		.from(orders)
		.where(and(eq(orders.id, input.orderId), eq(orders.ownerId, ownerId)));
	if (!order) throw new Error("NOT_FOUND");
	await db.transaction(async (tx) => {
		if (capture.documentId)
			await tx
				.update(documents)
				.set({ orderId: order.id, kind: input.documentKind })
				.where(
					and(
						eq(documents.id, capture.documentId),
						eq(documents.ownerId, ownerId),
					),
				);
		await tx
			.insert(orderCaptures)
			.values({ orderId: order.id, captureId: capture.id })
			.onConflictDoNothing();
		await markCaptureResolved(tx, capture.id);
		await audit(
			tx,
			{ type: "user", id: ownerId },
			"order.document_attached",
			order.id,
			{
				captureId: capture.id,
				documentId: capture.documentId,
			},
		);
	});
	publishLedgerEvent(ownerId, {
		type: "orders",
		orderIds: [order.id],
		created: 0,
	});
	return { ok: true, orderId: order.id };
}

export async function ignoreDocumentCapture(captureId: string) {
	const ownerId = (await requireUser()).id;
	await ownedCapture(ownerId, captureId);
	return ignoreCaptureForOwner(ownerId, captureId);
}

export async function restoreDocumentCapture(captureId: string) {
	const ownerId = (await requireUser()).id;
	await ownedCapture(ownerId, captureId);
	await db
		.update(captures)
		.set({ status: "no_orders", error: "needs review: restored" })
		.where(and(eq(captures.id, captureId), eq(captures.ownerId, ownerId)));
	return { ok: true };
}

export async function searchOrdersForAttach(
	input: z.output<typeof searchOrdersInput>,
) {
	return searchOrdersForAttachForOwner((await requireUser()).id, input);
}

export async function searchOrdersForAttachForOwner(
	ownerId: string,
	input: z.output<typeof searchOrdersInput>,
) {
	const where: SQL[] = [eq(orders.ownerId, ownerId)];
	if (input.q) {
		const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		const clause = or(
			ilike(orders.merchantName, like),
			ilike(orders.externalOrderId, like),
		);
		if (clause) where.push(clause);
	}
	const rows = await db
		.select({
			id: orders.id,
			source: orders.source,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			orderDate: orders.orderDate,
			totalMinor: orders.totalMinor,
			currency: orders.currency,
			hasInvoice: sql<boolean>`exists (select 1 from ${documents} d where d.order_id = ${orders.id} and d.kind in ('invoice', 'receipt'))`,
		})
		.from(orders)
		.where(and(...where))
		.orderBy(
			...(input.totalMinor !== undefined
				? [sql`(${orders.totalMinor} = ${input.totalMinor}) desc nulls last`]
				: []),
			desc(orders.orderDate),
		)
		.limit(20);
	return rows;
}
