import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { freePort } from "./email-dev";
import { captured } from "./email-mailpit";

// Root-only test of the actual unprivileged Node image, not an alternate server.
const network = process.argv[2];
assert.ok(network?.startsWith("email-compat-"));
const name = `email-production-${randomUUID().slice(0, 8)}`, port = await freePort();
const base = `http://127.0.0.1:${port}`, address = `${name}@example.test`;
let token = "", link = "", failed = false;
function docker(args: string[]) {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error("Production fixture container operation failed");
	return result.stdout;
}
try {
	const environment = {
		NODE_ENV: "production", APP_BASE_URL: base, BETTER_AUTH_SECRET: "production-email-fixture-only-secret-32-characters",
		DATABASE_URL: "postgresql://starter:starter@postgres:5432/starter", MAGIC_LINK_ENABLED: "true", SMTP_HOST: "mailpit", SMTP_PORT: "1025", SMTP_SECURITY: "opportunistic", EMAIL_FROM_ADDRESS: "starter@example.test", EMAIL_FROM_NAME: "Starter",
	};
	docker(["create", "--name", name, "--network", network, "-p", `127.0.0.1:${port}:3000`, ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), process.env.EMAIL_SMOKE_IMAGE || "ledgercatch:local"]);
	docker(["network", "connect", `${process.env.COMPOSE_PROJECT_NAME || "ledgercatch"}_default`, name]);
	docker(["start", name]);
	let ready = false;
	for (let i = 0; i < 60; i++) {
		try { const health = await fetch(`${base}/api/health`); if (health.ok) { ready = true; break; } } catch { /* Image starting. */ }
		await new Promise(resolve => setTimeout(resolve, 500));
	}
	assert.ok(ready);
	const response = await fetch(`${base}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ email: address, callbackURL: "/app" }) });
	assert.equal(response.status, 200);
	const mail = await captured(process.env.MAILPIT_API_URL!, item => item.To.some(to => to.Address === address));
	link = mail.Text.match(/https?:\/\/[^\s]+/)?.[0] || "";
	assert.equal(new URL(link).origin, base); assert.ok(mail.HTML.includes(link.replaceAll("&", "&amp;")));
	token = new URL(link).searchParams.get("token") || ""; assert.ok(token);
	const verify = await fetch(link, { redirect: "manual" });
	assert.ok([302, 303].includes(verify.status)); assert.ok(verify.headers.get("set-cookie")?.includes("session_token"));
	const logs = docker(["logs", name]);
	for (const value of [address, token, link, mail.Subject, mail.MessageID]) assert.ok(!logs.includes(value), "Production logs leaked email content");
} catch { failed = true; }
finally {
	try { docker(["rm", "-f", name]); } catch { failed = true; }
	// Delete only the uniquely-created fixture identity (sessions cascade); no schema changes.
	try {
		const { db } = await import("../src/db"); const { user } = await import("../src/db/schema"); const { eq } = await import("drizzle-orm");
		await db.delete(user).where(eq(user.email, address)); await db.$client.end();
	} catch { failed = true; }
}
if (failed) { console.error("Production Email SMTP fixture failed; output suppressed to protect tokens"); process.exitCode = 1; }
else console.info("Production Node image health, real SMTP magic-link delivery, session and safe logs passed");
