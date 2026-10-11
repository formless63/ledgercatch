/**
 * Parser for captures of kind "email": deterministic chain (schema.org
 * markup → store email parsers → platform/text heuristics), then AI
 * extraction on the visible text. When orders are found, invoice-like PDF
 * attachments are tagged with (source, externalOrderId) so capture
 * processing links them to the order (linkPendingDocuments).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "#/db";
import { documents } from "#/features/ledger/schema";
import {
	aiConfigured,
	extractWithAi,
} from "#/features/parsing/ai-extract.server";
import { buildEmailContext } from "#/features/parsing/email/common";
import { shopIdentity } from "#/features/parsing/email/generic";
import { parseEmailMessage } from "#/features/parsing/email/index";
import type { EmailMessage } from "#/features/parsing/email/types";
import type { ParsedOrder, ParseResult } from "#/features/parsing/types";
import { storeIdSchema } from "#/shared/capture";
import type { CaptureRow, KindParseOutcome } from "../types";
import type { EmailCaptureBody } from "./types";

function bodyOf(capture: CaptureRow): Partial<EmailCaptureBody> {
	const json = capture.bodyJson;
	return json && typeof json === "object" && !Array.isArray(json)
		? (json as Partial<EmailCaptureBody>)
		: {};
}

export function emailFromCapture(capture: CaptureRow): EmailMessage {
	const body = bodyOf(capture);
	const bodyText = capture.bodyText ?? "";
	const looksHtml = /<(?:html|body|table|div|p|br)\b/i.test(
		bodyText.slice(0, 20_000),
	);
	const source = storeIdSchema.safeParse(capture.source);
	return {
		source: source.success ? source.data : "generic",
		messageId: body.messageId ?? capture.sourceRef ?? capture.id,
		from: body.from ?? null,
		subject: body.subject ?? capture.pageTitle,
		date: body.date ?? capture.capturedAt.toISOString(),
		html: body.html ?? (looksHtml ? bodyText : undefined),
		text: body.text ?? (looksHtml ? undefined : bodyText),
		attachments: (body.attachments ?? []).map((a) => ({
			fileName: a.fileName,
			contentType: a.contentType,
		})),
	};
}

/** Mirrors ledger/process.server genericOrderKey (kept local: no import cycle). */
function genericKey(url: string | undefined, externalOrderId: string) {
	let host = "unknown";
	try {
		if (url) host = new URL(url).hostname.replace(/^www\./, "");
	} catch {}
	const id = externalOrderId.trim();
	return id.startsWith(`${host}:`) ? id : `${host}:${id}`;
}

async function aiFallback(
	capture: CaptureRow,
	email: EmailMessage,
	reason: string,
): Promise<KindParseOutcome | null> {
	if (!aiConfigured()) return null;
	const ctx = buildEmailContext(email);
	if (ctx.lines.length === 0) return null;
	const pageUrl =
		email.source === "generic"
			? (() => {
					const shop = shopIdentity(ctx);
					return shop.orderUrl ?? `https://${shop.host}/`;
				})()
			: `https://www.${email.source}.com/`;
	const header = [
		`From: ${email.from?.name ?? ""} <${email.from?.address ?? ""}>`,
		`Subject: ${email.subject}`,
		`Date: ${email.date ?? ""}`,
		email.attachments.length
			? `Attachments: ${email.attachments.map((a) => a.fileName).join(", ")}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
	const result = await extractWithAi({
		source: email.source,
		kind: "page_text",
		pageType: "unknown",
		pageUrl,
		pageTitle: email.subject,
		capturedAt: capture.capturedAt.toISOString(),
		orderIdHints: [],
		payload: {
			type: "text",
			text: `${header}\n\n${ctx.lines.join("\n")}`.slice(0, 500_000),
			note: `Deterministic email parsers found nothing: ${reason}`,
		},
	});
	if (result.outcome !== "orders") return null;
	return { result, parserId: "email-ai", version: 1 };
}

const INVOICE_HINT = /invoice|rechnung|factur|faktura|receipt|bill\b|beleg/i;

/**
 * Tag PDF attachments with the order they belong to. One order → every PDF;
 * several orders → only PDFs whose file name contains the order number.
 */
export async function linkEmailAttachments(
	capture: CaptureRow,
	email: EmailMessage,
	orders: ParsedOrder[],
) {
	const body = bodyOf(capture);
	const pdfs = (body.attachments ?? []).filter(
		(a) => a.contentType === "application/pdf",
	);
	if (pdfs.length === 0 || orders.length === 0) return;
	const subjectSaysInvoice = INVOICE_HINT.test(email.subject);
	for (const pdf of pdfs) {
		const order =
			orders.length === 1
				? orders[0]
				: orders.find((o) =>
						pdf.fileName
							.replace(/\s+/g, "")
							.includes(o.externalOrderId.replace(/\s+/g, "")),
					);
		if (!order) continue;
		const externalOrderId =
			capture.source === "generic"
				? genericKey(order.orderUrl ?? capture.pageUrl, order.externalOrderId)
				: order.externalOrderId;
		const isInvoice =
			INVOICE_HINT.test(pdf.fileName) ||
			subjectSaysInvoice ||
			// DigiKey / Mouser attach the invoice to shipping notices.
			((capture.source === "digikey" || capture.source === "mouser") &&
				/ship|invoice/i.test(email.subject));
		await db
			.update(documents)
			.set({
				source: capture.source,
				externalOrderId,
				...(isInvoice ? { kind: "invoice" as const } : {}),
			})
			.where(
				and(
					eq(documents.ownerId, capture.ownerId),
					inArray(documents.id, [pdf.documentId]),
					isNull(documents.orderId),
				),
			);
	}
}

export async function parseEmailCapture(
	capture: CaptureRow,
): Promise<KindParseOutcome> {
	const email = emailFromCapture(capture);
	let outcome: KindParseOutcome = parseEmailMessage(email);
	if (outcome.result.outcome !== "orders") {
		const reason = outcome.result.reason;
		const ai = await aiFallback(capture, email, reason).catch(
			(error: unknown): KindParseOutcome => ({
				result: {
					outcome: "unsupported",
					reason: `AI extraction failed: ${error instanceof Error ? error.message : String(error)}`,
				},
				parserId: "email-ai",
				version: 1,
			}),
		);
		if (ai) outcome = ai;
		else if (!aiConfigured()) {
			const result: ParseResult = {
				outcome: "no_orders",
				reason: `${reason} (AI fallback not configured — review manually)`,
			};
			outcome = { ...outcome, result };
		}
	}
	if (outcome.result.outcome === "orders")
		await linkEmailAttachments(capture, email, outcome.result.orders);
	return outcome;
}
