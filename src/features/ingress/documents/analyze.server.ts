/**
 * Document capture analysis: make sure the capture has a word-box layout
 * (body_json) and text (body_text), then run field extraction — heuristics,
 * saved per-merchant templates, and AI (when configured) for the gaps.
 *
 * body_json shape: { pages, ocrSource, synthetic?, extraction, ...other keys
 * the producing channel stored (kept as-is) }.
 */
import { and, desc, eq, like } from "drizzle-orm";
import { storeLabel } from "#/components/app/format";
import { db } from "#/db";
import { captures, documents } from "#/features/ledger/schema";
import {
	aiConfigured,
	extractWithAi,
} from "#/features/parsing/ai-extract.server";
import type { ParserInput } from "#/features/parsing/types";
import type { StoreId } from "#/shared/capture";
import { importTemplates } from "../schema";
import type { CaptureRow } from "../types";
import { extractDocumentLayout } from "./extract.server";
import {
	applyTemplate,
	type DocumentExtraction,
	extractFields,
	FIELD_KEYS,
	type FieldGuess,
	type FieldKey,
	isConfidentExtraction,
	locateValue,
	merchantSlug,
	mergeGuesses,
	minorToDecimal,
	readTemplateMapping,
	type TemplateMapping,
} from "./fields";
import {
	buildLines,
	type DocumentLayout,
	layoutFromText,
	plainText,
	readLayout,
} from "./layout";

export const TEMPLATE_PREFIX = "document:";

export type DocumentAnalysis = {
	layout: DocumentLayout;
	extraction: DocumentExtraction;
	text: string;
};

function bodyObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function readExtraction(value: unknown): DocumentExtraction | null {
	const raw = bodyObject(value).extraction;
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Partial<DocumentExtraction>;
	if (e.version !== 1 || typeof e.fields !== "object") return null;
	return {
		version: 1,
		fields: e.fields ?? {},
		items: Array.isArray(e.items) ? e.items : [],
		aiUsed: Boolean(e.aiUsed),
		templateId: e.templateId,
		warnings: Array.isArray(e.warnings) ? e.warnings : [],
	};
}

const normalize = (s: string) =>
	s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** The owner's saved template whose merchant appears on page 1 (longest match). */
export async function findTemplate(
	ownerId: string,
	layout: DocumentLayout,
	merchantHint?: string,
): Promise<{ id: string; mapping: TemplateMapping } | null> {
	const rows = await db
		.select({
			id: importTemplates.id,
			source: importTemplates.source,
			mapping: importTemplates.mapping,
		})
		.from(importTemplates)
		.where(
			and(
				eq(importTemplates.ownerId, ownerId),
				like(importTemplates.source, `${TEMPLATE_PREFIX}%`),
			),
		)
		.orderBy(desc(importTemplates.updatedAt))
		.limit(300);
	const firstPage = normalize(
		plainText({ ...layout, pages: layout.pages.slice(0, 1) }),
	);
	const hintSlug = merchantHint ? merchantSlug(merchantHint) : undefined;
	let best: { id: string; mapping: TemplateMapping; score: number } | null =
		null;
	for (const row of rows) {
		const mapping = readTemplateMapping(row.mapping);
		if (!mapping) continue;
		const slug = row.source.slice(TEMPLATE_PREFIX.length);
		const name = normalize(mapping.merchantName);
		let score = 0;
		if (hintSlug && slug === hintSlug) score = 1000;
		else if (name.length >= 3 && firstPage.includes(name)) score = name.length;
		if (score > 0 && (!best || score > best.score))
			best = { id: row.id, mapping, score };
	}
	return best ? { id: best.id, mapping: best.mapping } : null;
}

async function aiGuesses(
	capture: CaptureRow,
	layout: DocumentLayout,
	text: string,
	currency: string | undefined,
): Promise<{
	fields: Partial<Record<FieldKey, FieldGuess>>;
	items: DocumentExtraction["items"];
}> {
	const input: ParserInput = {
		source: "generic" as StoreId,
		kind: "page_text",
		pageType: "invoice",
		pageUrl: capture.pageUrl,
		pageTitle: capture.pageTitle,
		capturedAt: capture.capturedAt.toISOString(),
		orderIdHints: capture.orderIdHints,
		payload: {
			type: "text",
			text,
			note: "This text was extracted from an uploaded invoice/receipt document.",
		},
	};
	const result = await extractWithAi(input);
	if (result.outcome !== "orders") return { fields: {}, items: [] };
	const order = result.orders[0];
	if (!order) return { fields: {}, items: [] };
	const lines = buildLines(layout);
	const cur = order.currency ?? currency;
	const values: Partial<Record<FieldKey, string | undefined>> = {
		merchantName: order.merchantName,
		externalOrderId: order.externalOrderId,
		orderDate: order.orderDate,
		currency: order.currency,
		subtotal:
			order.subtotalMinor != null
				? minorToDecimal(order.subtotalMinor, cur)
				: undefined,
		shipping:
			order.shippingMinor != null
				? minorToDecimal(order.shippingMinor, cur)
				: undefined,
		tax:
			order.taxMinor != null ? minorToDecimal(order.taxMinor, cur) : undefined,
		discount:
			order.discountMinor != null
				? minorToDecimal(Math.abs(order.discountMinor), cur)
				: undefined,
		total:
			order.totalMinor != null
				? minorToDecimal(order.totalMinor, cur)
				: undefined,
		paymentLast4: order.paymentLast4,
	};
	const fields: Partial<Record<FieldKey, FieldGuess>> = {};
	for (const key of FIELD_KEYS) {
		const value = values[key];
		if (!value) continue;
		const refs =
			key === "currency" ? [] : locateValue(layout, key, value, lines, cur);
		// Values we can see on the page are more trustworthy.
		fields[key] = {
			value,
			confidence: refs.length || key === "currency" ? 0.75 : 0.6,
			refs,
			via: "ai",
		};
	}
	const items = (order.items ?? []).map((item) => ({
		title: item.title,
		quantity: String(item.quantity || 1),
		unitPrice:
			item.unitPriceMinor != null
				? minorToDecimal(item.unitPriceMinor, cur)
				: undefined,
		total:
			item.totalMinor != null
				? minorToDecimal(item.totalMinor, cur)
				: undefined,
		refs: locateValue(layout, "merchantName", item.title.slice(0, 40), lines),
	}));
	return { fields, items };
}

/** Field extraction over a layout for one owner (templates + AI). */
export async function extractForCapture(
	capture: CaptureRow,
	layout: DocumentLayout,
	text: string,
	options: { useAi?: boolean } = {},
): Promise<DocumentExtraction> {
	const knownStore = capture.source !== "generic";
	const extraction = extractFields(layout);
	if (knownStore)
		extraction.fields.merchantName = {
			value: storeLabel(capture.source),
			confidence: 0.95,
			refs: extraction.fields.merchantName?.refs ?? [],
			via: "text",
		};
	const template = await findTemplate(
		capture.ownerId,
		layout,
		extraction.fields.merchantName?.value,
	).catch(() => null);
	if (template) {
		const currency = extraction.fields.currency?.value;
		extraction.fields = mergeGuesses(
			extraction.fields,
			applyTemplate(layout, template.mapping, { currency }),
		);
		if (!knownStore)
			extraction.fields.merchantName = {
				value: template.mapping.merchantName,
				confidence: 0.9,
				refs:
					locateValue(layout, "merchantName", template.mapping.merchantName) ??
					[],
				via: "template",
			};
		extraction.templateId = template.id;
	}
	if (
		options.useAi !== false &&
		aiConfigured() &&
		text.trim().length > 20 &&
		!isConfidentExtraction(extraction, { knownMerchant: knownStore })
	) {
		try {
			const ai = await aiGuesses(
				capture,
				layout,
				text,
				extraction.fields.currency?.value,
			);
			extraction.fields = mergeGuesses(extraction.fields, ai.fields);
			if (extraction.items.length === 0) extraction.items = ai.items;
			extraction.aiUsed = true;
		} catch (error) {
			extraction.warnings.push(
				`AI extraction failed: ${error instanceof Error ? error.message : String(error)}`.slice(
					0,
					300,
				),
			);
		}
	}
	extraction.warnings = extraction.warnings.filter(
		(w) =>
			!(w.startsWith("No order") && extraction.fields.externalOrderId) &&
			!(w.startsWith("No total") && extraction.fields.total),
	);
	return extraction;
}

async function loadDocument(ownerId: string, documentId: string) {
	const [doc] = await db
		.select()
		.from(documents)
		.where(and(eq(documents.id, documentId), eq(documents.ownerId, ownerId)));
	return doc ?? null;
}

/**
 * Ensures layout + text exist (extracting from the stored document when
 * needed), runs extraction and persists both on the capture.
 *
 * `ocr: "force"` re-extracts from the document even when text exists.
 */
export async function analyzeDocumentCapture(
	capture: CaptureRow,
	options: { ocr?: "auto" | "force"; useAi?: boolean; budgetMs?: number } = {},
): Promise<DocumentAnalysis> {
	const body = bodyObject(capture.bodyJson);
	let layout = options.ocr === "force" ? null : readLayout(body);
	let text = capture.bodyText?.trim() ?? "";
	const warnings: string[] = [];
	const hadText = text.length > 0;

	if (!layout && capture.documentId) {
		const doc = await loadDocument(capture.ownerId, capture.documentId);
		if (!doc) throw new Error("Document not found");
		const { readDocumentBytes } = await import(
			"#/features/ledger/documents.server"
		);
		const bytes = await readDocumentBytes(doc.storageKey);
		// With text already provided (Paperless / email OCR), only read the PDF
		// text layer for geometry; never re-OCR unless forced.
		const ocr = options.ocr === "force" || !hadText;
		const isPdf = doc.contentType === "application/pdf";
		if (ocr || isPdf) {
			const extracted = await extractDocumentLayout(bytes, doc.contentType, {
				ocr,
				budgetMs: options.budgetMs,
			});
			warnings.push(...extracted.warnings);
			const wordCount = extracted.layout.pages.reduce(
				(n, p) => n + p.words.length,
				0,
			);
			if (wordCount > 0 || !hadText) {
				layout = extracted.layout;
				if (!hadText || options.ocr === "force") text = extracted.text;
			}
		}
	}
	if (!layout && text) layout = layoutFromText(text, "paperless");
	if (!layout) layout = { pages: [], ocrSource: "pdf-text" };

	const extraction = await extractForCapture(capture, layout, text, {
		useAi: options.useAi,
	});
	extraction.warnings.push(...warnings);

	const next = {
		...body,
		pages: layout.pages,
		ocrSource: layout.ocrSource,
		synthetic: layout.synthetic ?? false,
		extraction,
	};
	await db
		.update(captures)
		.set({
			bodyJson: next,
			...(text && (!hadText || options.ocr === "force")
				? { bodyText: text.slice(0, 500_000) }
				: {}),
		})
		.where(eq(captures.id, capture.id));
	return { layout, extraction, text };
}
