import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { maybeQueueEnrichment } from "#/features/ingress/enrichment/queue.server";
import { parseCaptureByKind } from "#/features/ingress/kinds.server";
import { loadCaptureBody } from "#/features/ops/compaction.server";
import { extractWithAi } from "#/features/parsing/ai-extract.server";
import { getParser } from "#/features/parsing/registry";
import type { ParseResult, ParserInput } from "#/features/parsing/types";
import type { CapturePayload, StoreId } from "#/shared/capture";
import { linkPendingDocuments } from "./documents.server";
import { publishLedgerEvent } from "./events.server";
import {
	audit,
	recomputeAllocations,
	type Tx,
	upsertParsedOrder,
} from "./orders.server";
import { emitCaptureFailed, emitOrderEvent } from "./outbound.server";
import { resetCaptureSupportForOwner } from "./reparse-support.server";
import { evaluateRules, type RuleSubject } from "./rules";
import {
	captures,
	categories,
	entities,
	orderItems,
	orders,
	paymentMethods,
	rules,
} from "./schema";

function payloadOf(capture: typeof captures.$inferSelect): CapturePayload {
	if (capture.kind === "api_json")
		return {
			type: "json",
			requestUrl: capture.requestUrl ?? capture.pageUrl,
			body: capture.bodyJson,
		};
	if (capture.kind === "html_snapshot")
		return { type: "html", html: capture.bodyText ?? "" };
	return {
		type: "text",
		text: capture.bodyText ?? "",
		note: capture.note ?? undefined,
	};
}

async function runParser(
	capture: typeof captures.$inferSelect,
): Promise<{ result: ParseResult; parserId: string; version: number }> {
	const byKind = await parseCaptureByKind(capture);
	if (byKind) return byKind;
	const input: ParserInput = {
		source: capture.source as StoreId,
		kind: capture.kind as ParserInput["kind"],
		pageType: capture.pageType as ParserInput["pageType"],
		pageUrl: capture.pageUrl,
		pageTitle: capture.pageTitle,
		capturedAt: capture.capturedAt.toISOString(),
		capturedLocalDate: capture.capturedLocalDate ?? undefined,
		orderIdHints: capture.orderIdHints,
		payload: payloadOf(capture),
	};
	// "Track this page" may carry the page DOM next to its text (payload
	// `html`, persisted as body_json `{ html }`). Try the deterministic parser
	// for the source on it first (for unknown stores: the generic parser with
	// platform markup, JSON-LD, data layers); only fall back to AI on the
	// text when it finds nothing.
	const pageHtml =
		capture.kind === "page_text" &&
		capture.bodyJson !== null &&
		typeof capture.bodyJson === "object" &&
		!Array.isArray(capture.bodyJson) &&
		typeof (capture.bodyJson as { html?: unknown }).html === "string"
			? (capture.bodyJson as { html: string }).html
			: undefined;
	if (pageHtml) {
		const htmlParser = getParser(input.source);
		if (htmlParser) {
			const result = htmlParser.parse({
				...input,
				kind: "html_snapshot",
				payload: { type: "html", html: pageHtml },
			});
			if (result.outcome === "orders")
				return {
					result,
					parserId: htmlParser.source,
					version: htmlParser.version,
				};
		}
	}
	const parser =
		capture.kind === "page_text" ? undefined : getParser(input.source);
	if (parser) {
		const result = parser.parse(input);
		if (result.outcome === "orders" || input.source !== "generic")
			return { result, parserId: parser.source, version: parser.version };
	}
	// Manual "track this page" captures and unknown stores go to AI extraction.
	if (capture.kind === "page_text" || input.source === "generic") {
		const result = await extractWithAi(input);
		return { result, parserId: "ai", version: 1 };
	}
	return {
		result: { outcome: "unsupported", reason: `No parser for ${input.source}` },
		parserId: "none",
		version: 0,
	};
}

const REVIEWABLE_KINDS = new Set(["page_text", "document", "email"]);

export async function applyRulesToNewOrder(
	tx: Tx,
	ownerId: string,
	orderId: string,
) {
	const activeRules = await tx
		.select()
		.from(rules)
		.where(and(eq(rules.ownerId, ownerId), eq(rules.enabled, true)))
		.orderBy(asc(rules.priority));
	if (activeRules.length === 0) return;
	const subject = await loadRuleSubject(tx, ownerId, orderId);
	if (!subject) return;
	const { actions, matchedRuleIds } = evaluateRules(activeRules, subject);
	if (matchedRuleIds.length === 0) return;
	// Retained rules may predate current validation. Never apply a foreign reference.
	if (
		actions.categoryId &&
		!(
			await tx
				.select({ id: categories.id })
				.from(categories)
				.where(
					and(
						eq(categories.id, actions.categoryId),
						eq(categories.ownerId, ownerId),
					),
				)
		)[0]
	)
		throw new Error("Unknown category");
	if (
		actions.entityId &&
		!(
			await tx
				.select({ id: entities.id })
				.from(entities)
				.where(
					and(eq(entities.id, actions.entityId), eq(entities.ownerId, ownerId)),
				)
		)[0]
	)
		throw new Error("Unknown entity");

	const [order] = await tx
		.select({ entityId: orders.entityId, tags: orders.tags })
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	const entityId = order?.entityId ?? actions.entityId ?? null;
	await tx
		.update(orders)
		.set({
			entityId,
			...(actions.categoryId ? { categoryId: actions.categoryId } : {}),
			...(actions.reimbursable === "yes"
				? { reimbursableOverride: true }
				: actions.reimbursable === "no"
					? { reimbursableOverride: false }
					: {}),
			...(actions.tags?.length
				? { tags: [...new Set([...(order?.tags ?? []), ...actions.tags])] }
				: {}),
			...(actions.file && entityId
				? { reviewState: "filed" as const, filedAt: new Date() }
				: {}),
			ruleId: matchedRuleIds[0],
			updatedAt: new Date(),
		})
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	for (const ruleId of matchedRuleIds) {
		const [rule] = await tx
			.select({ matchCount: rules.matchCount })
			.from(rules)
			.where(eq(rules.id, ruleId));
		await tx
			.update(rules)
			.set({
				matchCount: (rule?.matchCount ?? 0) + 1,
				lastMatchedAt: new Date(),
			})
			.where(eq(rules.id, ruleId));
	}
	await audit(
		tx,
		{ type: "system", id: "rules" },
		"order.rules_applied",
		orderId,
		{
			ruleIds: matchedRuleIds,
			actions,
		},
	);
}

export async function loadRuleSubject(
	tx: Tx | typeof db,
	ownerId: string,
	orderId: string,
): Promise<RuleSubject | null> {
	const [order] = await tx
		.select({
			source: orders.source,
			merchantName: orders.merchantName,
			placedByGroup: orders.placedByGroup,
			shipToAddress: orders.shipToAddress,
			checkoutEmailDomain: orders.checkoutEmailDomain,
			totalMinor: orders.totalMinor,
			currency: orders.currency,
			last4: paymentMethods.last4,
		})
		.from(orders)
		.leftJoin(paymentMethods, eq(paymentMethods.id, orders.paymentMethodId))
		.where(and(eq(orders.id, orderId), eq(orders.ownerId, ownerId)));
	if (!order) return null;
	const items = await tx
		.select({ title: orderItems.title, sku: orderItems.sku })
		.from(orderItems)
		.innerJoin(orders, eq(orders.id, orderItems.orderId))
		.where(and(eq(orderItems.orderId, orderId), eq(orders.ownerId, ownerId)));
	return {
		source: order.source,
		merchant: order.merchantName,
		placedByGroup: order.placedByGroup,
		shipToAddress: order.shipToAddress,
		checkoutEmailDomain: order.checkoutEmailDomain,
		itemTitles: items.map((item) => item.title),
		skus: items.flatMap((item) => (item.sku ? [item.sku] : [])),
		paymentLast4: order.last4 || null,
		totalMinor: order.totalMinor,
		currency: order.currency,
	};
}

export function genericOrderKey(url: string, externalOrderId: string) {
	let host = "unknown";
	try {
		host = new URL(url).hostname.replace(/^www\./, "");
	} catch {}
	const id = externalOrderId.trim();
	return id.startsWith(`${host}:`) ? id : `${host}:${id}`;
}

/** Job handler: parse a capture and merge its orders. */
export async function processCapture(captureId: string) {
	let [capture] = await db
		.select()
		.from(captures)
		.where(eq(captures.id, captureId));
	if (!capture) return { skipped: "missing" };
	if (capture.status === "ignored") return { skipped: "ignored" };
	// Compacted captures keep large bodies in object storage.
	capture = await loadCaptureBody(capture);

	let parsed: Awaited<ReturnType<typeof runParser>>;
	try {
		parsed = await runParser(capture);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(captures)
			.set({
				status: "failed",
				error: message.slice(0, 2000),
				parsedAt: new Date(),
			})
			.where(eq(captures.id, captureId));
		void emitCaptureFailed(captureId);
		return { failed: message };
	}

	const { result, parserId, version } = parsed;
	if (result.outcome !== "orders") {
		await db.transaction(async (tx) => {
			// Errors/unsupported formats cannot disprove an older parse.
			if (result.outcome === "no_orders")
				await resetCaptureSupportForOwner(tx, capture.ownerId, captureId);
			await tx
				.update(captures)
				.set({
					// Human-supplied material (manual page captures, uploaded/Paperless
					// documents, emails) always lands in review when nothing parsed.
					status: REVIEWABLE_KINDS.has(capture.kind)
						? "needs_review"
						: result.outcome === "no_orders"
							? "no_orders"
							: "failed",
					error: result.reason.slice(0, 2000),
					parserId,
					parserVersion: version,
					ordersFound: 0,
					parsedAt: new Date(),
				})
				.where(eq(captures.id, captureId));
		});
		void emitCaptureFailed(captureId);
		publishLedgerEvent(capture.ownerId, { type: "capture", captureId });
		return { outcome: result.outcome };
	}

	const source = capture.source;
	const touched: Array<{
		orderId: string;
		created: boolean;
		externalOrderId: string;
	}> = [];
	await db.transaction(async (tx) => {
		await resetCaptureSupportForOwner(tx, capture.ownerId, captureId);
		for (const parsedOrder of result.orders) {
			if (!parsedOrder.externalOrderId) continue;
			// Unknown stores share source "generic": namespace their order numbers
			// by shop host so two shops' "#1001" never merge.
			const order =
				source === "generic"
					? {
							...parsedOrder,
							externalOrderId: genericOrderKey(
								parsedOrder.orderUrl ?? capture.pageUrl,
								parsedOrder.externalOrderId,
							),
						}
					: parsedOrder;
			const outcome = await upsertParsedOrder(
				tx,
				capture.ownerId,
				source,
				order,
				captureId,
			);
			touched.push({ ...outcome, externalOrderId: order.externalOrderId });
			if (outcome.created) {
				await audit(
					tx,
					{ type: "system", id: "ingest" },
					"order.captured",
					outcome.orderId,
					{
						captureId,
						source,
						parser: parserId,
					},
				);
				await applyRulesToNewOrder(tx, capture.ownerId, outcome.orderId);
			} else if (
				outcome.itemsReplaced ||
				order.placedByGroup ||
				order.shipToAddress ||
				order.checkoutEmailDomain
			) {
				// Fuller item data arrived (e.g. detail page after a list page):
				// rules matching titles/SKUs get another chance while still untriaged.
				const [current] = await tx
					.select({ reviewState: orders.reviewState, ruleId: orders.ruleId })
					.from(orders)
					.where(eq(orders.id, outcome.orderId));
				if (current?.reviewState === "inbox" && !current.ruleId)
					await applyRulesToNewOrder(tx, capture.ownerId, outcome.orderId);
			}
			await recomputeAllocations(tx, outcome.orderId);
			await maybeQueueEnrichment(tx, {
				ownerId: capture.ownerId,
				orderId: outcome.orderId,
				source,
				captureChannel: capture.channel,
			});
		}
		await tx
			.update(captures)
			.set({
				status: touched.length ? "parsed" : "no_orders",
				error: result.warnings.length
					? result.warnings.join("\n").slice(0, 2000)
					: null,
				parserId,
				parserVersion: version,
				ordersFound: touched.length,
				parsedAt: new Date(),
			})
			.where(eq(captures.id, captureId));
	});

	for (const order of touched)
		await linkPendingDocuments(
			capture.ownerId,
			source,
			order.externalOrderId,
			order.orderId,
		);

	for (const order of touched)
		if (order.created)
			void emitOrderEvent(capture.ownerId, order.orderId, "order.created");
	publishLedgerEvent(capture.ownerId, {
		type: "orders",
		orderIds: touched.map((order) => order.orderId),
		created: touched.filter((order) => order.created).length,
	});
	return {
		orders: touched.length,
		created: touched.filter((o) => o.created).length,
	};
}

/** Re-run rules for unassigned inbox orders (manual "apply rules" action). */
export async function applyRulesToInbox(ownerId: string) {
	const inbox = await db
		.select({ id: orders.id, ruleId: orders.ruleId })
		.from(orders)
		.where(and(eq(orders.ownerId, ownerId), eq(orders.reviewState, "inbox")));
	let changed = 0;
	// Small transactions so a large inbox never holds locks against the worker.
	for (let i = 0; i < inbox.length; i += 25) {
		const batch = inbox.slice(i, i + 25);
		await db.transaction(async (tx) => {
			for (const { id, ruleId } of batch) {
				await applyRulesToNewOrder(tx, ownerId, id);
				const [after] = await tx
					.select({ ruleId: orders.ruleId })
					.from(orders)
					.where(eq(orders.id, id));
				if (after?.ruleId && after.ruleId !== ruleId) changed++;
				await recomputeAllocations(tx, id);
			}
		});
	}
	if (changed)
		publishLedgerEvent(ownerId, { type: "orders", orderIds: [], created: 0 });
	return { changed };
}

export async function ordersExist(
	ownerId: string,
	source: string,
	externalOrderIds: string[],
) {
	if (externalOrderIds.length === 0) return [];
	return db
		.select({ id: orders.id, externalOrderId: orders.externalOrderId })
		.from(orders)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				eq(orders.source, source),
				inArray(orders.externalOrderId, externalOrderIds),
			),
		);
}
