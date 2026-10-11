import { createHash, randomBytes } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "#/db";
import { session, user, verification } from "#/db/schema";
import { auth } from "./auth";

// Sign-up is closed by default; allow this fixture domain before env is parsed.
vi.hoisted(() => {
	process.env.ALLOWED_SIGNUP_EMAILS = "@example.test";
});

const address = `auth-regression-${crypto.randomUUID()}@example.test`;
let deliveredUrl = "";
// Reuse the reference configuration/adapter with an in-process test transport.
// No real provider or SMTP credentials are added.
const testAuth = betterAuth({
	...auth.options,
	plugins: [
		...auth.options.plugins.filter(
			(plugin) => !["magic-link", "tanstack-start-cookies"].includes(plugin.id),
		),
		magicLink({
			storeToken: "hashed",
			async sendMagicLink({ url }) {
				deliveredUrl = url;
			},
		}),
	],
});
const base = auth.options.baseURL as string;
const verificationPrefix = `auth-state:regression-${crypto.randomUUID()}-`;

afterAll(async () => {
	await db.delete(user).where(eq(user.email, address));
	await db
		.delete(verification)
		.where(like(verification.identifier, `${verificationPrefix}%`));
	await db.delete(verification).where(like(verification.value, `%${address}%`));
});

describe("Better Auth 1.7.7 passwordless regression", () => {
	it("keeps global identifier hashing unset and passwords disabled", () => {
		const options: BetterAuthOptions = auth.options;
		expect(options.verification?.storeIdentifier).toBeUndefined();
		expect(auth.options.emailAndPassword?.enabled).toBe(false);
	});
	it("stores a purpose-prefixed token hash, creates a human session and rejects replay", async () => {
		const response = await testAuth.handler(
			new Request(`${base}/api/auth/sign-in/magic-link`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: base },
				body: JSON.stringify({ email: address, callbackURL: "/app" }),
			}),
		);
		expect(response.status).toBe(200);
		const token = new URL(deliveredUrl).searchParams.get("token");
		if (!token) throw new Error("Missing test token");
		const rows = await db.select().from(verification);
		const stored = rows.find((row) => row.value.includes(address));
		expect(stored?.identifier.startsWith("magic-link:")).toBe(true);
		expect(stored?.identifier.includes(token)).toBe(false);
		const verified = await testAuth.handler(new Request(deliveredUrl));
		expect(verified.status).toBe(302);
		expect(new URL(verified.headers.get("location") || "", base).pathname).toBe(
			"/app",
		);
		const cookie = verified.headers.get("set-cookie") || "";
		expect(cookie).toContain("session_token");
		const restored = await testAuth.api.getSession({
			headers: new Headers({ cookie }),
		});
		expect(restored?.user.email).toBe(address);
		expect(restored?.user.emailVerified).toBe(true);
		const replay = await testAuth.handler(new Request(deliveredUrl));
		expect(replay.headers.get("set-cookie") || "").not.toContain(
			"session_token",
		);
		expect(replay.headers.get("location")).toContain("error=");
	});
	it("rejects auth-state identifiers as Magic Links without consuming their rows", async () => {
		const token = randomBytes(32).toString("base64url");
		const context = await testAuth.$context;
		// Use the native auth-state prefix and a Magic-Link-shaped value deliberately:
		// even a compatible JSON shape must not cross verification purposes.
		const identifier = `${verificationPrefix}${token}`;
		await context.internalAdapter.createVerificationValue({
			identifier,
			value: JSON.stringify({ email: address, name: "Regression" }),
			expiresAt: new Date(Date.now() + 60_000),
		});
		const [owner] = await db.select().from(user).where(eq(user.email, address));
		if (!owner) throw new Error("Missing fixture owner");
		const ownedSessions = () =>
			db.select().from(session).where(eq(session.userId, owner.id));
		const before = await ownedSessions();
		const response = await testAuth.handler(
			new Request(
				`${base}/api/auth/magic-link/verify?token=${encodeURIComponent(identifier.slice("auth-state:".length))}&callbackURL=/app`,
			),
		);
		expect(response.headers.get("set-cookie") || "").not.toContain(
			"session_token",
		);
		expect(response.headers.get("location")).toContain("error=");
		expect(
			await context.internalAdapter.findVerificationValue(identifier),
		).toBeTruthy();
		expect(await ownedSessions()).toHaveLength(before.length);
	});
	it("rejects expired links and pre-upgrade unprefixed verification identifiers", async () => {
		const token = randomBytes(32).toString("base64url");
		const digest = createHash("sha256").update(token).digest("base64url");
		const context = await testAuth.$context;
		await context.internalAdapter.createVerificationValue({
			identifier: digest,
			value: JSON.stringify({ email: address }),
			expiresAt: new Date(Date.now() + 60_000),
		});
		const legacy = await testAuth.handler(
			new Request(
				`${base}/api/auth/magic-link/verify?token=${token}&callbackURL=/app`,
			),
		);
		expect(legacy.headers.get("set-cookie") || "").not.toContain(
			"session_token",
		);
		expect(legacy.headers.get("location")).toContain("error=");
		expect(
			await context.internalAdapter.findVerificationValue(digest),
		).toBeTruthy();
		await context.internalAdapter.createVerificationValue({
			identifier: `magic-link:${digest}`,
			value: JSON.stringify({ email: address }),
			expiresAt: new Date(Date.now() - 60_000),
		});
		const expired = await testAuth.handler(
			new Request(
				`${base}/api/auth/magic-link/verify?token=${token}&callbackURL=/app`,
			),
		);
		expect(expired.headers.get("set-cookie") || "").not.toContain(
			"session_token",
		);
		expect(expired.headers.get("location")).toContain("error=");
	});
});
