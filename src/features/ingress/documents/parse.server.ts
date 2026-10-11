/**
 * Parser for kind "document" captures (uploads, email attachments,
 * Paperless). Confident extractions (order #, total, merchant) become orders;
 * everything else returns `no_orders` with a "needs review" reason and is
 * listed in the assisted review queue (Import → Documents), which shows every
 * document capture without a linked order.
 *
 * Generic orders are keyed per merchant: orderUrl `upload://<merchant-slug>/`
 * makes the ingest step store external ids as "<merchant-slug>:<order #>".
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { documents } from "#/features/ledger/schema";
import type { CaptureRow, KindParseOutcome } from "../types";
import { analyzeDocumentCapture } from "./analyze.server";
import {
	extractionToParsedOrder,
	isConfidentExtraction,
	merchantOrderUrl,
} from "./fields";

export const DOCUMENT_PARSER_ID = "document";
export const DOCUMENT_PARSER_VERSION = 1;
export const NEEDS_REVIEW = "needs review";

const outcome = (result: KindParseOutcome["result"]): KindParseOutcome => ({
	result,
	parserId: DOCUMENT_PARSER_ID,
	version: DOCUMENT_PARSER_VERSION,
});

export async function parseDocumentCapture(
	capture: CaptureRow,
): Promise<KindParseOutcome> {
	if (!capture.documentId && !capture.bodyText?.trim())
		return outcome({
			outcome: "no_orders",
			reason: `${NEEDS_REVIEW}: no document or text attached`,
		});
	let analysis: Awaited<ReturnType<typeof analyzeDocumentCapture>>;
	try {
		analysis = await analyzeDocumentCapture(capture, { budgetMs: 120_000 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return outcome({
			outcome: "no_orders",
			reason: `${NEEDS_REVIEW}: text extraction failed — ${message}`,
		});
	}
	const { extraction } = analysis;
	const knownMerchant = capture.source !== "generic";
	if (!isConfidentExtraction(extraction, { knownMerchant }))
		return outcome({
			outcome: "no_orders",
			reason: `${NEEDS_REVIEW}: ${
				extraction.warnings.join("; ") || "fields need confirmation"
			}`.slice(0, 500),
		});
	const merchantName = extraction.fields.merchantName?.value;
	const order = extractionToParsedOrder(extraction, {
		merchantName,
		orderUrl:
			capture.source === "generic" && merchantName
				? merchantOrderUrl(merchantName)
				: undefined,
	});
	if (!order)
		return outcome({
			outcome: "no_orders",
			reason: `${NEEDS_REVIEW}: no order number`,
		});

	// Let the ingest step attach the document once the order exists.
	if (capture.documentId) {
		let key = order.externalOrderId;
		if (capture.source === "generic" && order.orderUrl) {
			const { genericOrderKey } = await import(
				"#/features/ledger/process.server"
			);
			key = genericOrderKey(order.orderUrl, order.externalOrderId);
		}
		await db
			.update(documents)
			.set({ source: capture.source, externalOrderId: key })
			.where(
				and(
					eq(documents.id, capture.documentId),
					eq(documents.ownerId, capture.ownerId),
					isNull(documents.orderId),
				),
			);
	}
	return outcome({
		outcome: "orders",
		orders: [order],
		warnings: [
			extraction.aiUsed
				? "Extracted from document with AI assistance — verify amounts"
				: "Extracted from document — verify amounts",
		],
	});
}
