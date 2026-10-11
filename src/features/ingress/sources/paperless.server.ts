/**
 * Paperless-ngx source: pull tagged (or typed) documents, keep a copy of the
 * original file, and hand Paperless' OCR text to the "document" capture
 * parser. Optional push of our invoices back into Paperless.
 *
 * API: Token auth (`Authorization: Token …`), DRF pagination
 * ({count,next,results}), filters `tags__name__iexact`,
 * `document_type__name__iexact`, `correspondent__name__icontains`,
 * `modified__gt`, `ordering=modified`; original file at
 * `/api/documents/{id}/download/?original=true`; upload at
 * `/api/documents/post_document/` (multipart, returns a task UUID).
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { decryptSecret } from "#/features/connectors/crypto.server";
import {
	readDocumentBytes,
	storeDocument,
} from "#/features/ledger/documents.server";
import { documents } from "#/features/ledger/schema";
import { MAX_DOCUMENT_BYTES, type StoreId } from "#/shared/capture";
import { createServerCapture } from "../captures.server";
import { ingressSources } from "../schema";
import type { IngressSourceRow, SourceModule } from "../types";

export type PaperlessConfig = {
	baseUrl: string;
	tag?: string;
	documentType?: string;
	correspondentFilter?: string;
	pushInvoices: boolean;
	pushTag?: string;
};

const MAX_PER_POLL = 50;
const PAGE_SIZE = 25;
const TIMEOUT_MS = 60_000;

const text = (v: unknown) =>
	typeof v === "string" && v.trim() ? v.trim() : undefined;

export function paperlessConfig(source: IngressSourceRow): PaperlessConfig {
	const raw = source.config as Record<string, unknown>;
	const baseUrl = text(raw.baseUrl)
		?.replace(/\/+$/, "")
		.replace(/\/api$/, "");
	if (!baseUrl || !/^https?:\/\//i.test(baseUrl))
		throw new Error("Paperless source: base URL is not set");
	const documentType = text(raw.documentType);
	return {
		baseUrl,
		tag: text(raw.tag) ?? (documentType ? undefined : "order"),
		documentType,
		correspondentFilter: text(raw.correspondentFilter),
		pushInvoices: raw.pushInvoices === true || raw.pushInvoices === "true",
		pushTag: text(raw.pushTag),
	};
}

function paperlessToken(source: IngressSourceRow): string {
	if (!source.secretCiphertext)
		throw new Error("Paperless source: API token is not set");
	const secret = decryptSecret<{ token?: string }>(source.secretCiphertext);
	if (!secret.token?.trim())
		throw new Error("Paperless source: API token is not set");
	return secret.token.trim();
}

type Client = {
	baseUrl: string;
	request(path: string, init?: RequestInit): Promise<Response>;
	json<T>(path: string): Promise<T>;
};

function client(source: IngressSourceRow): Client {
	const { baseUrl } = paperlessConfig(source);
	const token = paperlessToken(source);
	const request = async (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Token ${token}`);
		if (!headers.has("Accept")) headers.set("Accept", "application/json");
		const res = await fetch(`${baseUrl}${path}`, {
			...init,
			headers,
			redirect: "follow",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, 300);
			throw new Error(
				`Paperless ${path.split("?")[0]} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
			);
		}
		return res;
	};
	return {
		baseUrl,
		request,
		json: async <T>(path: string) => (await (await request(path)).json()) as T,
	};
}

/** DRF `next` links may carry the server's own host; keep only path+query. */
export function relativeNext(next: string | null | undefined): string | null {
	if (!next) return null;
	try {
		const url = new URL(next);
		const apiAt = url.pathname.indexOf("/api/");
		return `${apiAt >= 0 ? url.pathname.slice(apiAt) : url.pathname}${url.search}`;
	} catch {
		return next.startsWith("/") ? next : null;
	}
}

type Page<T> = { count?: number; next?: string | null; results?: T[] };
type NamedRow = { id: number; name: string };
type PaperlessDocument = {
	id: number;
	title?: string;
	content?: string;
	created?: string;
	created_date?: string;
	modified?: string;
	added?: string;
	correspondent?: number | null;
	document_type?: number | null;
	tags?: number[];
	original_file_name?: string | null;
	archived_file_name?: string | null;
	mime_type?: string;
};

async function nameMap(c: Client, path: string): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	let next: string | null = `${path}?page_size=1000`;
	for (let i = 0; next && i < 5; i++) {
		const page: Page<NamedRow> = await c.json<Page<NamedRow>>(next);
		for (const row of page.results ?? []) out.set(row.id, row.name);
		next = relativeNext(page.next);
	}
	return out;
}

const STORE_PATTERNS: Array<[StoreId, RegExp]> = [
	["amazon", /\bamazon(\.[a-z.]+)?\b|\bamzn\b/i],
	["aliexpress", /\baliexpress\b/i],
	["alibaba", /\balibaba(\.com)?\b/i],
	["ebay", /\bebay\b/i],
	["digikey", /\bdigi-?key\b/i],
	["mouser", /\bmouser\b/i],
];

/** Guess the store from the correspondent first, then title and content. */
export function guessStore(input: {
	correspondent?: string | null;
	title?: string | null;
	content?: string | null;
}): StoreId {
	for (const haystack of [
		input.correspondent ?? "",
		input.title ?? "",
		(input.content ?? "").slice(0, 4000),
	]) {
		if (!haystack) continue;
		for (const [store, pattern] of STORE_PATTERNS)
			if (pattern.test(haystack)) return store;
	}
	return "generic";
}

export function guessDocumentKind(input: {
	title?: string | null;
	documentType?: string | null;
}): "invoice" | "receipt" {
	const hay = `${input.documentType ?? ""} ${input.title ?? ""}`;
	return /receipt|quittung|beleg|ticket/i.test(hay) &&
		!/invoice|rechnung|facture/i.test(hay)
		? "receipt"
		: "invoice";
}

export function documentsQuery(
	config: PaperlessConfig,
	modifiedAfter: string | undefined,
): string {
	const params = new URLSearchParams();
	if (config.tag) params.set("tags__name__iexact", config.tag);
	if (config.documentType)
		params.set("document_type__name__iexact", config.documentType);
	if (config.correspondentFilter)
		params.set("correspondent__name__icontains", config.correspondentFilter);
	if (modifiedAfter) params.set("modified__gt", modifiedAfter);
	params.set("ordering", "modified");
	params.set("page_size", String(PAGE_SIZE));
	return `/api/documents/?${params}`;
}

function fileNameOf(doc: PaperlessDocument, res: Response): string {
	const disposition = res.headers.get("content-disposition") ?? "";
	const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
	if (match?.[1]) {
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return match[1];
		}
	}
	return doc.original_file_name || `${doc.title || `paperless-${doc.id}`}.pdf`;
}

async function downloadOriginal(
	c: Client,
	doc: PaperlessDocument,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
	const res = await c.request(
		`/api/documents/${doc.id}/download/?original=true`,
		{
			headers: { Accept: "*/*" },
		},
	);
	const declared = Number(res.headers.get("content-length") ?? 0);
	if (declared > MAX_DOCUMENT_BYTES)
		throw new Error(
			`document ${doc.id} is larger than ${MAX_DOCUMENT_BYTES} bytes`,
		);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.byteLength > MAX_DOCUMENT_BYTES)
		throw new Error(
			`document ${doc.id} is larger than ${MAX_DOCUMENT_BYTES} bytes`,
		);
	return {
		bytes,
		contentType:
			res.headers.get("content-type") ?? doc.mime_type ?? "application/pdf",
		fileName: fileNameOf(doc, res),
	};
}

type NameMaps = {
	tags: Map<number, string>;
	correspondents: Map<number, string>;
	types: Map<number, string>;
};

async function importDocument(
	c: Client,
	source: IngressSourceRow,
	doc: PaperlessDocument,
	maps: NameMaps,
) {
	const correspondent =
		doc.correspondent != null
			? (maps.correspondents.get(doc.correspondent) ?? null)
			: null;
	const documentType =
		doc.document_type != null
			? (maps.types.get(doc.document_type) ?? null)
			: null;
	const store = guessStore({
		correspondent,
		title: doc.title,
		content: doc.content,
	});
	const detailsUrl = `${c.baseUrl}/documents/${doc.id}/details`;
	const file = await downloadOriginal(c, doc);
	const stored = await storeDocument({
		ownerId: source.ownerId,
		bytes: file.bytes,
		contentType: file.contentType,
		fileName: file.fileName,
		kind: guessDocumentKind({ title: doc.title, documentType }),
		source: store === "generic" ? null : store,
		originUrl: detailsUrl,
	});
	return createServerCapture({
		ownerId: source.ownerId,
		channel: "paperless",
		sourceRef: `${c.baseUrl}#${doc.id}`,
		kind: "document",
		source: store,
		pageType: "invoice",
		pageUrl: detailsUrl,
		pageTitle: doc.title ?? "",
		bodyText: doc.content ?? "",
		bodyJson: {
			paperless: {
				id: doc.id,
				title: doc.title ?? null,
				created: doc.created ?? doc.created_date ?? null,
				correspondent,
				tags: (doc.tags ?? []).map((id) => maps.tags.get(id) ?? String(id)),
				documentType,
			},
			ocrSource: "paperless",
		},
		documentId: stored.id,
	});
}

export const paperlessSource: SourceModule = {
	label: "Paperless-ngx",
	description:
		"Import invoices and receipts from Paperless-ngx (by tag or document type), reusing its OCR text. Optionally push invoices back.",
	configFields: [
		{
			key: "baseUrl",
			label: "Paperless URL",
			type: "url",
			required: true,
			placeholder: "https://paperless.example.com",
		},
		{
			key: "tag",
			label: "Tag",
			type: "text",
			placeholder: "order",
			help: "Import documents with this tag (default “order”). Leave empty when filtering by document type.",
		},
		{
			key: "documentType",
			label: "Document type",
			type: "text",
			help: "Alternatively (or additionally) import documents of this type, e.g. “Invoice”.",
		},
		{
			key: "correspondentFilter",
			label: "Correspondent contains",
			type: "text",
			help: "Optional: only correspondents whose name contains this text.",
		},
		{
			key: "pushInvoices",
			label: "Push invoices to Paperless",
			type: "checkbox",
			help: "Allow sending invoices captured by this app to Paperless.",
		},
		{
			key: "pushTag",
			label: "Tag for pushed documents",
			type: "text",
			placeholder: "ledgercatch",
			help: "Added to documents we upload. Use a different tag than the import tag; documents with it are never imported back.",
		},
	],
	secretFields: [
		{
			key: "token",
			label: "API token",
			type: "password",
			required: true,
			help: "Paperless → profile (top right) → API Auth Token.",
		},
	],

	async poll(source) {
		const config = paperlessConfig(source);
		const c = client(source);
		const cursor = (source.cursor ?? {}) as { modifiedAfter?: string };
		const [tags, correspondents, types] = await Promise.all([
			nameMap(c, "/api/tags/"),
			nameMap(c, "/api/correspondents/"),
			nameMap(c, "/api/document_types/"),
		]);
		const maps = { tags, correspondents, types };
		const pushTagId = config.pushTag
			? [...tags].find(
					([, name]) => name.toLowerCase() === config.pushTag?.toLowerCase(),
				)?.[0]
			: undefined;

		let lastGood = cursor.modifiedAfter;
		let next: string | null = documentsQuery(config, lastGood);
		let processed = 0;
		let created = 0;
		let failure: string | null = null;
		pages: while (next) {
			const page: Page<PaperlessDocument> =
				await c.json<Page<PaperlessDocument>>(next);
			for (const doc of page.results ?? []) {
				if (processed >= MAX_PER_POLL) break pages;
				processed++;
				// Our own uploads come back with the push tag: never re-import them.
				if (pushTagId === undefined || !doc.tags?.includes(pushTagId)) {
					try {
						if ((await importDocument(c, source, doc, maps)).created) created++;
					} catch (error) {
						// Ordered by modified: stop here so the next poll retries this one.
						failure = `#${doc.id}: ${error instanceof Error ? error.message : String(error)}`;
						break pages;
					}
				}
				if (doc.modified) lastGood = doc.modified;
			}
			next = relativeNext(page.next);
		}
		if (failure && lastGood === cursor.modifiedAfter) throw new Error(failure);
		return {
			cursor: lastGood ? { modifiedAfter: lastGood } : undefined,
			created,
			summary: `${processed} document(s) checked, ${created} imported${failure ? `; stopped at ${failure}` : ""}`,
		};
	},

	async test(source) {
		try {
			const config = paperlessConfig(source);
			const c = client(source);
			const all = await c.json<Page<unknown>>("/api/documents/?page_size=1");
			const matching = await c.json<Page<unknown>>(
				documentsQuery(config, undefined).replace(
					`page_size=${PAGE_SIZE}`,
					"page_size=1",
				),
			);
			return {
				ok: true,
				message: `Connected. ${matching.count ?? 0} matching of ${all.count ?? 0} document(s).`,
			};
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

async function ensureTagId(c: Client, name: string): Promise<number> {
	const found = await c.json<Page<NamedRow>>(
		`/api/tags/?name__iexact=${encodeURIComponent(name)}`,
	);
	const hit = found.results?.[0];
	if (hit) return hit.id;
	const res = await c.request("/api/tags/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, matching_algorithm: 0 }),
	});
	return ((await res.json()) as NamedRow).id;
}

/**
 * Upload one of our documents to Paperless (POST /api/documents/post_document/).
 * Returns Paperless' consumption task id. `ownerId` scopes the lookup when
 * called on behalf of a user.
 */
export async function pushDocumentToPaperless(
	sourceId: string,
	documentId: string,
	ownerId?: string,
): Promise<{ taskId: string }> {
	const [source] = await db
		.select()
		.from(ingressSources)
		.where(
			and(
				eq(ingressSources.id, sourceId),
				eq(ingressSources.kind, "paperless"),
				...(ownerId ? [eq(ingressSources.ownerId, ownerId)] : []),
			),
		);
	if (!source) throw new Error("NOT_FOUND");
	const config = paperlessConfig(source);
	if (!config.pushInvoices)
		throw new Error(
			"Pushing documents is turned off for this Paperless source",
		);
	const [doc] = await db
		.select()
		.from(documents)
		.where(
			and(eq(documents.id, documentId), eq(documents.ownerId, source.ownerId)),
		);
	if (!doc) throw new Error("NOT_FOUND");
	const c = client(source);
	const bytes = await readDocumentBytes(doc.storageKey);
	const form = new FormData();
	form.set(
		"document",
		new Blob([bytes as Uint8Array<ArrayBuffer>], { type: doc.contentType }),
		doc.fileName,
	);
	form.set("title", doc.fileName.replace(/\.[a-z0-9]{2,5}$/i, ""));
	if (config.pushTag)
		form.append("tags", String(await ensureTagId(c, config.pushTag)));
	const res = await c.request("/api/documents/post_document/", {
		method: "POST",
		body: form,
	});
	const body = (await res.text()).trim();
	return { taskId: body.replace(/^"|"$/g, "") };
}
