/**
 * Building and validating CaptureEnvelopes. Pure: callers inject the id,
 * timestamp and version so this is trivially testable.
 */
import {
	CAPTURE_SCHEMA_VERSION,
	type CaptureEnvelope,
	type CaptureKind,
	type CapturePayload,
	MAX_HTML_BYTES,
	MAX_TEXT_BYTES,
	type PageType,
	type StoreId,
	captureEnvelopeSchema,
} from "@app/shared/capture";
import { z } from "zod";
import { MAX_ORDER_ID_HINTS } from "./stores";
import { sanitizeUrl, truncateToBytes } from "./util";

export type CaptureTrigger = CaptureEnvelope["trigger"];

/** What content scripts / popup hand to the background. */
export interface CaptureDraft {
	source: StoreId;
	kind: CaptureKind;
	trigger: CaptureTrigger;
	pageType: PageType;
	pageUrl: string;
	pageTitle: string;
	orderIdHints: string[];
	payload: CapturePayload;
}

export interface EnvelopeContext {
	captureId: string;
	capturedAt: string;
	extensionVersion: string;
}

export type BuildResult = { ok: true; envelope: CaptureEnvelope } | { ok: false; error: string };

function kindMatchesPayload(kind: CaptureKind, payload: CapturePayload): boolean {
	return (
		(kind === "api_json" && payload.type === "json") ||
		(kind === "html_snapshot" && payload.type === "html") ||
		(kind === "page_text" && payload.type === "text")
	);
}

function clampPayload(payload: CapturePayload): CapturePayload {
	switch (payload.type) {
		case "html":
			return { ...payload, html: truncateToBytes(payload.html, MAX_HTML_BYTES) };
		case "text":
			return {
				...payload,
				text: truncateToBytes(payload.text, MAX_TEXT_BYTES),
				note: payload.note?.trim() ? payload.note.trim().slice(0, 2000) : undefined,
			};
		case "json": {
			const requestUrl = sanitizeUrl(payload.requestUrl) ?? payload.requestUrl;
			return { ...payload, requestUrl };
		}
	}
}

export function buildEnvelope(draft: CaptureDraft, ctx: EnvelopeContext): BuildResult {
	if (!kindMatchesPayload(draft.kind, draft.payload)) {
		return { ok: false, error: `kind ${draft.kind} does not match payload type ${draft.payload.type}` };
	}
	const pageUrl = sanitizeUrl(draft.pageUrl);
	if (!pageUrl) return { ok: false, error: `unsupported page URL: ${draft.pageUrl.slice(0, 200)}` };
	const hints = [...new Set(draft.orderIdHints.map((h) => h.trim()).filter((h) => h && h.length <= 120))].slice(
		0,
		MAX_ORDER_ID_HINTS,
	);
	const candidate = {
		schemaVersion: CAPTURE_SCHEMA_VERSION,
		captureId: ctx.captureId,
		source: draft.source,
		kind: draft.kind,
		trigger: draft.trigger,
		pageType: draft.pageType,
		pageUrl,
		pageTitle: draft.pageTitle.slice(0, 1000),
		capturedAt: ctx.capturedAt,
		extensionVersion: ctx.extensionVersion.slice(0, 40),
		orderIdHints: hints,
		payload: clampPayload(draft.payload),
	};
	const parsed = captureEnvelopeSchema.safeParse(candidate);
	if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
	return { ok: true, envelope: parsed.data };
}

/** The string hashed for de-duplication: identical content for the same URL. */
export function dedupeMaterial(draft: CaptureDraft): string {
	const p = draft.payload;
	switch (p.type) {
		case "json": {
			// mtop URLs carry timestamps/signatures; key on origin+path only.
			let urlKey = p.requestUrl;
			try {
				const u = new URL(p.requestUrl);
				urlKey = `${u.origin}${u.pathname}`;
			} catch {
				/* keep raw */
			}
			return `${draft.source}|json|${urlKey}|${JSON.stringify(p.body)}`;
		}
		case "html":
			return `${draft.source}|html|${draft.pageUrl}|${p.html}`;
		case "text":
			return `${draft.source}|text|${draft.pageUrl}|${p.text}|${p.note ?? ""}`;
	}
}
