/**
 * Capture retention / compaction: pure helpers (settings resolution and the
 * gzip envelope). I/O lives in compaction.server.ts.
 */
import { gunzipSync, gzipSync } from "node:zlib";

export const DEFAULT_KEEP_RAW_DAYS = 365;
export const DEFAULT_COMPACT_MIN_BYTES = 256 * 1024;
export const DEFAULT_COMPACT_BATCH = 10;
/** Capture kinds whose bodies may be compacted. Document/import/agent rows stay inline (small, or queried in SQL by review screens). */
export const COMPACTABLE_KINDS = [
	"html_snapshot",
	"api_json",
	"page_text",
	"email",
] as const;

export type RetentionDefaults = {
	enabled: boolean;
	keepRawDays: number;
	compactMinBytes: number;
	batch: number;
};

function intFrom(
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
) {
	if (!raw?.trim() || !/^\d+$/.test(raw.trim())) return fallback;
	const n = Number(raw.trim());
	return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Env defaults: CAPTURE_COMPACTION (on|off), CAPTURE_RETENTION_DAYS, CAPTURE_COMPACT_MIN_BYTES, CAPTURE_COMPACT_BATCH. */
export function retentionDefaults(
	env: NodeJS.ProcessEnv = process.env,
): RetentionDefaults {
	return {
		enabled: (env.CAPTURE_COMPACTION ?? "on").trim().toLowerCase() !== "off",
		keepRawDays: intFrom(
			env.CAPTURE_RETENTION_DAYS,
			DEFAULT_KEEP_RAW_DAYS,
			1,
			36_500,
		),
		compactMinBytes: intFrom(
			env.CAPTURE_COMPACT_MIN_BYTES,
			DEFAULT_COMPACT_MIN_BYTES,
			1024,
			1024 * 1024 * 1024,
		),
		batch: intFrom(env.CAPTURE_COMPACT_BATCH, DEFAULT_COMPACT_BATCH, 0, 100),
	};
}

export type CompactedPointer = {
	storageKey: string;
	/** Uncompressed size of the moved body (bodyText + bodyJson, UTF-8 JSON). */
	bytes: number;
	/** Size of the gzip object. */
	storedBytes: number;
	sha256: string;
	compactedAt: string;
	v: 1;
};

/** The pointer stored in captures.body_json once the body has moved, or null. */
export function compactedPointer(bodyJson: unknown): CompactedPointer | null {
	if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson))
		return null;
	const keys = Object.keys(bodyJson);
	if (keys.length !== 1 || keys[0] !== "compacted") return null;
	const pointer = (bodyJson as { compacted?: unknown }).compacted;
	if (!pointer || typeof pointer !== "object") return null;
	const p = pointer as Partial<CompactedPointer>;
	return typeof p.storageKey === "string" &&
		p.storageKey.length > 0 &&
		typeof p.bytes === "number"
		? (p as CompactedPointer)
		: null;
}

type Body = { bodyText: string | null; bodyJson: unknown };
type Envelope = { v: 1 } & Body;

export function encodeCompactedBody(body: Body): {
	gzip: Uint8Array;
	bytes: number;
} {
	const json = JSON.stringify({
		v: 1,
		bodyText: body.bodyText,
		bodyJson: body.bodyJson ?? null,
	} satisfies Envelope);
	const raw = Buffer.from(json, "utf8");
	return {
		gzip: new Uint8Array(gzipSync(raw, { level: 6 })),
		bytes: raw.length,
	};
}

export function decodeCompactedBody(gzip: Uint8Array): Body {
	const parsed = JSON.parse(
		gunzipSync(gzip).toString("utf8"),
	) as Partial<Envelope>;
	if (parsed?.v !== 1) throw new Error("Unknown compacted capture format");
	return {
		bodyText: typeof parsed.bodyText === "string" ? parsed.bodyText : null,
		bodyJson: parsed.bodyJson ?? null,
	};
}
