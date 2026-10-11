/** Small, defensive helpers for walking untrusted JSON bodies. */

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts parsed JSON, a JSON string, or a JSONP string; never throws. */
export function unwrapBody(body: unknown): unknown {
	if (typeof body !== "string") return body;
	const text = body.trim();
	if (!text) return undefined;
	const tryParse = (s: string): unknown => {
		try {
			return JSON.parse(s);
		} catch {
			return undefined;
		}
	};
	const direct = tryParse(text);
	if (direct !== undefined) return direct;
	const jsonp = /^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text);
	return jsonp ? tryParse(jsonp[1] ?? "") : undefined;
}

/** Reads a dotted path ("a.b.0.c"); arrays accept numeric segments. */
export function getPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const segment of path.split(".")) {
		if (Array.isArray(current)) current = current[Number(segment)];
		else if (isRecord(current)) current = current[segment];
		else return undefined;
	}
	return current;
}

export function str(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.replace(/\s+/g, " ").trim();
		return trimmed || undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

export function num(value: unknown): number | undefined {
	if (typeof value === "number")
		return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value))
		return Number(value);
	return undefined;
}

/** Array or object-of-objects (AliExpress sometimes sends maps) → array. */
export function asArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (isRecord(value)) return Object.values(value).filter((v) => isRecord(v));
	return [];
}

export function records(value: unknown): JsonRecord[] {
	return asArray(value).filter(isRecord);
}

/** Depth-first search collecting records that satisfy `predicate`. */
export function findRecords(
	root: unknown,
	predicate: (record: JsonRecord) => boolean,
	options: {
		maxDepth?: number;
		limit?: number;
		descendIntoMatches?: boolean;
	} = {},
): JsonRecord[] {
	const { maxDepth = 14, limit = 500, descendIntoMatches = false } = options;
	const out: JsonRecord[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown, depth: number) => {
		if (out.length >= limit || depth > maxDepth) return;
		if (typeof value !== "object" || value === null || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const child of value) visit(child, depth + 1);
			return;
		}
		const record = value as JsonRecord;
		const matched = predicate(record);
		if (matched) out.push(record);
		if (matched && !descendIntoMatches) return;
		for (const child of Object.values(record)) visit(child, depth + 1);
	};
	visit(root, 0);
	return out;
}

/** Reads a query parameter; tolerant of relative URLs and bad input. */
export function queryParam(
	url: string | undefined,
	name: string,
): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url, "https://example.invalid/");
		const value = parsed.searchParams.get(name);
		if (value) return value;
		const lower = name.toLowerCase();
		for (const [key, v] of parsed.searchParams)
			if (key.toLowerCase() === lower && v) return v;
	} catch {
		// fall through
	}
	return undefined;
}

/**
 * Parses a JS object literal as found in inline scripts (single quotes,
 * unquoted keys, trailing commas). Returns undefined for anything that is
 * not plain data (function calls, variables…).
 */
export function parseLooseJson(source: string): unknown {
	const strict = (() => {
		try {
			return JSON.parse(source);
		} catch {
			return undefined;
		}
	})();
	if (strict !== undefined) return strict;
	let out = "";
	let i = 0;
	const n = source.length;
	while (i < n) {
		const ch = source[i] as string;
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			let value = "";
			while (j < n && source[j] !== ch) {
				if (source[j] === "\\" && j + 1 < n) {
					const next = source[j + 1] as string;
					value += next === "'" || next === "`" ? next : `\\${next}`;
					j += 2;
					continue;
				}
				if (ch === "`" && source[j] === "$" && source[j + 1] === "{")
					return undefined;
				const c = source[j] as string;
				value += c === '"' ? '\\"' : c === "\n" ? "\\n" : c;
				j += 1;
			}
			if (j >= n) return undefined;
			out += `"${value}"`;
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i;
			while (j < n && /[\w$]/.test(source[j] as string)) j += 1;
			const word = source.slice(i, j);
			let k = j;
			while (k < n && /\s/.test(source[k] as string)) k += 1;
			if (source[k] === ":") out += `"${word}"`;
			else if (word === "true" || word === "false" || word === "null")
				out += word;
			else if (word === "undefined") out += "null";
			else return undefined;
			i = j;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			while (i < n && source[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? n : end + 2;
			continue;
		}
		if (ch === "(" || ch === ")" || ch === "=" || ch === ";") return undefined;
		out += ch;
		i += 1;
	}
	out = out.replace(/,\s*([}\]])/g, "$1");
	try {
		return JSON.parse(out);
	} catch {
		return undefined;
	}
}

/**
 * Returns the balanced `{…}` substring that starts at `start` (which must be
 * a "{"), or undefined. String-aware.
 */
export function balancedObjectAt(
	text: string,
	start: number,
): string | undefined {
	if (text[start] !== "{") return undefined;
	let depth = 0;
	let quote: string | undefined;
	for (let i = start; i < text.length && i - start < 200_000; i += 1) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Finds data objects inside script text that contain `key`: walks outward
 * from each occurrence through enclosing braces (nearest first) and returns
 * the parsed objects that are plain data.
 */
export function objectsAroundKey(
	text: string,
	key: RegExp,
	maxLevels = 4,
): JsonRecord[] {
	const out: JsonRecord[] = [];
	const flags = key.flags.includes("g") ? key.flags : `${key.flags}g`;
	for (const m of text.matchAll(new RegExp(key.source, flags))) {
		let pos = m.index ?? 0;
		let levels = 0;
		let depth = 0;
		for (
			let i = pos - 1;
			i >= 0 && levels < maxLevels && pos - i < 50_000;
			i -= 1
		) {
			const ch = text[i];
			if (ch === "}") depth += 1;
			else if (ch === "{") {
				if (depth > 0) {
					depth -= 1;
					continue;
				}
				levels += 1;
				const literal = balancedObjectAt(text, i);
				if (!literal) continue;
				const parsed = parseLooseJson(literal);
				if (isRecord(parsed)) out.push(parsed);
				pos = i;
			}
		}
	}
	return out;
}

/** First present value among `names`, matching keys case-insensitively. */
export function field(
	record: JsonRecord | undefined,
	...names: string[]
): unknown {
	if (!record) return undefined;
	for (const name of names)
		if (record[name] !== undefined && record[name] !== null)
			return record[name];
	const lower = new Map(Object.keys(record).map((k) => [k.toLowerCase(), k]));
	for (const name of names) {
		const key = lower.get(name.toLowerCase());
		if (key !== undefined && record[key] !== undefined && record[key] !== null)
			return record[key];
	}
	return undefined;
}

/** schema.org style "one or many": a single object becomes a one-item list. */
export function oneOrMany(value: unknown): JsonRecord[] {
	if (Array.isArray(value)) return value.filter(isRecord);
	return isRecord(value) ? [value] : [];
}
