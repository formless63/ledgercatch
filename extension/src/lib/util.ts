/** Small pure helpers shared across contexts. */

const encoder = new TextEncoder();

export function byteLength(s: string): number {
	return encoder.encode(s).byteLength;
}

/** Truncate a string so its UTF-8 encoding fits in `maxBytes`. */
export function truncateToBytes(s: string, maxBytes: number): string {
	if (s.length <= maxBytes / 3) return s;
	const bytes = encoder.encode(s);
	if (bytes.byteLength <= maxBytes) return s;
	// Decode a prefix; `fatal: false` drops a trailing partial code point.
	let out = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
	if (out.endsWith("�")) out = out.slice(0, -1);
	return out;
}

/** Remove userinfo (credentials) and the fragment from a URL. */
export function sanitizeUrl(raw: string, base?: string): string | null {
	try {
		const u = new URL(raw, base);
		if (!/^https?:$/.test(u.protocol)) return null;
		u.username = "";
		u.password = "";
		u.hash = "";
		return u.toString();
	} catch {
		return null;
	}
}

/** Normalise a user-entered server URL to `scheme://host[:port][/base]` without trailing slash. */
export function normalizeServerUrl(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	try {
		const u = new URL(trimmed);
		if (!/^https?:$/.test(u.protocol)) return null;
		if (u.username || u.password) return null;
		if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null;
		u.hash = "";
		u.search = "";
		return u.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

/** `https://host:port/*` origin pattern for chrome.permissions. */
export function originPattern(serverUrl: string): string | null {
	try {
		return `${new URL(serverUrl).origin}/*`;
	} catch {
		return null;
	}
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function localDay(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function safeFileName(name: string, fallback = "document"): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
	return cleaned || fallback;
}
