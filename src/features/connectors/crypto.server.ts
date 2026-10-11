/**
 * Connector secret encryption at rest (connections.secret_ciphertext).
 * AES-256-GCM; key = HKDF-SHA256(APP_ENCRYPTION_KEY ?? BETTER_AUTH_SECRET).
 * Format: `v1.<iv b64url>.<tag b64url>.<data b64url>`.
 */
import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";

const VERSION = "v1";
const HKDF_SALT = "ledgercatch/connectors";
const HKDF_INFO = "connector-secret-encryption/v1";
const AAD = Buffer.from("ledgercatch:connector-secret:v1");
const MIN_KEY_LENGTH = 32;

let cached: { material: string; key: Buffer } | undefined;

function deriveKey(): Buffer {
	const material =
		process.env.APP_ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET || "";
	if (!material) {
		throw new Error(
			"Connector secret encryption needs APP_ENCRYPTION_KEY (or BETTER_AUTH_SECRET) to be set",
		);
	}
	if (material.length < MIN_KEY_LENGTH) {
		throw new Error(
			`APP_ENCRYPTION_KEY / BETTER_AUTH_SECRET must be at least ${MIN_KEY_LENGTH} characters`,
		);
	}
	if (cached?.material === material) return cached.key;
	const key = Buffer.from(
		hkdfSync("sha256", material, HKDF_SALT, HKDF_INFO, 32),
	);
	cached = { material, key };
	return key;
}

/** Throws a clear error if no usable key is configured. */
export function assertEncryptionKeyConfigured(): void {
	deriveKey();
}

export function encryptSecret(value: unknown): string {
	const key = deriveKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(AAD);
	const data = Buffer.concat([
		cipher.update(JSON.stringify(value), "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return [
		VERSION,
		iv.toString("base64url"),
		tag.toString("base64url"),
		data.toString("base64url"),
	].join(".");
}

export function decryptSecret<T = unknown>(ciphertext: string): T {
	const parts = ciphertext.split(".");
	if (parts.length !== 4 || parts[0] !== VERSION) {
		throw new Error("Unsupported connector secret format");
	}
	const key = deriveKey();
	const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
	try {
		const iv = Buffer.from(ivB64, "base64url");
		const tag = Buffer.from(tagB64, "base64url");
		if (iv.length !== 12 || tag.length !== 16) throw new Error("bad lengths");
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(AAD);
		decipher.setAuthTag(tag);
		const plain = Buffer.concat([
			decipher.update(Buffer.from(dataB64, "base64url")),
			decipher.final(),
		]).toString("utf8");
		return JSON.parse(plain) as T;
	} catch {
		throw new Error(
			"Could not decrypt connector secret (encryption key changed or data tampered); re-enter the credentials",
		);
	}
}
