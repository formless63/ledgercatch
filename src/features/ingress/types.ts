import type { captures } from "#/features/ledger/schema";
import type { ParseResult } from "#/features/parsing/types";
import type { ingressSources } from "./schema";

export type CaptureRow = typeof captures.$inferSelect;
export type IngressSourceRow = typeof ingressSources.$inferSelect;

/** Server-side capture kinds (the extension contract only uses the first three). */
export type ServerCaptureKind =
	| "api_json"
	| "html_snapshot"
	| "page_text"
	| "email"
	| "document"
	| "import_row"
	| "agent";

export type CaptureChannel =
	| "extension"
	| "upload"
	| "email"
	| "import"
	| "paperless"
	| "agent"
	| "api";

export type KindParseOutcome = {
	result: ParseResult;
	parserId: string;
	version: number;
};

export type SourceField = {
	key: string;
	label: string;
	type: "url" | "text" | "password" | "number" | "select" | "checkbox";
	help?: string;
	placeholder?: string;
	required?: boolean;
	options?: Array<{ value: string; label: string }>;
};

/** Pollable source module (IMAP, Paperless, store APIs). */
export type SourceModule = {
	label: string;
	description: string;
	/** Non-secret settings stored in ingress_sources.config. */
	configFields: SourceField[];
	/** Secrets stored encrypted in ingress_sources.secret_ciphertext (APP_ENCRYPTION_KEY). */
	secretFields: SourceField[];
	/** Fetch new items, create captures; return a new cursor and a summary. */
	poll(source: IngressSourceRow): Promise<{
		cursor?: Record<string, unknown>;
		created: number;
		summary: string;
	}>;
	/** Validate connectivity/credentials without importing anything. */
	test(source: IngressSourceRow): Promise<{ ok: boolean; message: string }>;
};
