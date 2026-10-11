import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";
import { createEmail, resolveEmailConfig, EmailError, type EmailMessage } from "../src/integrations/email/email.server";
import { renderMagicLinkEmail } from "../src/integrations/email/magic-link.server";
import { docker, fixtureEnvironment, freePort, waitForMailpit } from "./email-dev";
import { api, captured } from "./email-mailpit";

const project = `email-compat-${randomUUID().slice(0, 8)}`;
const smtp = await freePort(), ui = await freePort();
const overrides = { MAILPIT_SMTP_PORT: String(smtp), MAILPIT_UI_PORT: String(ui), MAILPIT_TEST_CHAOS: "true", MAILPIT_TEST_AUTH: "true", MAILPIT_ALLOWED_RECIPIENTS: "@example\\.test$" };
const environment = fixtureEnvironment(smtp, ui);
const url = environment.MAILPIT_API_URL!;
const compose = ["compose", "-f", "compose.email.yaml", "-p", project];
// Transparent local TCP tap observes original SMTP DATA. Mailpit adds a Bcc
// header to its stored capture, so its raw-download endpoint is not wire MIME.
let wire = "";
const sockets = new Set<ReturnType<typeof connect>>();
const tap = createServer(client => {
	const upstream = connect(smtp, "127.0.0.1");
	sockets.add(client); sockets.add(upstream);
	client.on("data", chunk => { wire += chunk.toString(); });
	client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
	client.on("close", () => sockets.delete(client)); upstream.on("close", () => sockets.delete(upstream));
	client.pipe(upstream).pipe(client);
});
await new Promise<void>(resolve => tap.listen(0, "127.0.0.1", resolve));
const tapAddress = tap.address();
assert.ok(tapAddress && typeof tapAddress !== "string");
const config = resolveEmailConfig({ ...environment, SMTP_PORT: String(tapAddress.port) }), email = createEmail(config);
try {
	docker([...compose, "up", "-d", "mailpit"], overrides);
	await waitForMailpit(url);
	await email.verifyEmailTransport();
	assert.equal((await (await api(url, "messages")).json() as { total: number }).total, 0, "verify must send no mail");
	for (const mode of ["text", "html", "multipart"] as const) {
		const id = randomUUID();
		const subject = `SMTP ${mode} 世界 ${id}`;
		const content = renderMagicLinkEmail({ appName: "<Starter> & Friends", url: "https://app.example.test/sign-in?token=fixture&next=%2F", appBaseUrl: "https://app.example.test" });
		const result = await email.sendEmail({ to: [{ address: `${id}@example.test` }], cc: [{ address: `cc-${id}@example.test` }], bcc: [{ address: `bcc-${id}@example.test` }], subject, ...(mode !== "html" ? { text: `Unicode ☕ ${content.text}` } : {}), ...(mode !== "text" ? { html: content.html } : {}) });
		assert.equal(typeof result.accepted, "number"); assert.equal(typeof result.rejected, "number");
		assert.equal(result.outcome, "accepted"); assert.equal(result.accepted, 3); assert.ok(result.messageId);
		const mail = await captured(url, item => item.Subject === subject);
		assert.equal(mail.From.Address, config.from.address); assert.equal(mail.ReplyTo[0]?.Address, config.replyTo?.address);
		assert.equal(mail.To[0]?.Address, `${id}@example.test`); assert.equal(mail.Cc[0]?.Address, `cc-${id}@example.test`);
		assert.ok(mail.Bcc.some(item => item.Address === `bcc-${id}@example.test`), "SMTP envelope must include Bcc");
		assert.equal(mail.MessageID, result.messageId.replace(/^<|>$/g, ""));
		if (mode !== "html") assert.ok(mail.Text.includes("Unicode ☕"));
		if (mode !== "text") { assert.ok(mail.HTML.includes("&lt;Starter&gt; &amp; Friends")); assert.ok(mail.HTML.includes("&amp;next=")); }
		const messages = [...wire.matchAll(/DATA\r\n([\s\S]*?)\r\n\.\r\n/g)];
		const raw = messages.at(-1)?.[1] || ""; assert.ok(raw);
		assert.ok(wire.includes(`RCPT TO:<bcc-${id}@example.test>`));
		assert.doesNotMatch(raw.split(/\r?\n\r?\n/)[0]!, /^Bcc:/im, "Bcc cannot appear in transmitted MIME headers");
		assert.equal(mail.Attachments.length, 0); assert.equal(mail.Inline.length, 0);
	}
	const base: EmailMessage = { to: [{ address: "ok@example.test" }], subject: `Partial ${randomUUID()}`, text: "private fixture" };
	const partial = await email.sendEmail({ ...base, cc: [{ address: "rejected@outside.invalid" }] });
	assert.equal(partial.outcome, "partial"); assert.equal(partial.accepted, 1); assert.equal(partial.rejected, 1);
	await captured(url, item => item.Subject === base.subject);
	const before = (await (await api(url, "messages")).json() as { total: number }).total;
	await assert.rejects(email.sendEmail({ ...base, to: Array.from({ length: 51 }, () => ({ address: "ok@example.test" })) }), EmailError);
	for (const key of ["raw", "path", "href", "headers", "attachments"]) await assert.rejects(email.sendEmail({ ...base, [key]: "file:///etc/passwd" }), EmailError);
	await assert.rejects(email.sendEmail({ ...base, html: { href: "http://127.0.0.1/private" } } as unknown as EmailMessage), EmailError);
	assert.equal((await (await api(url, "messages")).json() as { total: number }).total, before);
	for (const [status, code, retryable] of [[451, "temporary-rejection", true], [550, "permanent-rejection", false]] as const) {
		await api(url, "chaos", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Sender: { ErrorCode: status, Probability: 100 } }) });
		const attemptsBefore = [...wire.matchAll(/MAIL FROM:/g)].length;
		await assert.rejects(email.sendEmail(base), error => error instanceof EmailError && error.code === code && error.retryable === retryable);
		assert.equal((await (await api(url, "messages")).json() as { total: number }).total, before, "No automatic send retry or unexpected capture");
 assert.equal([...wire.matchAll(/MAIL FROM:/g)].length, attemptsBefore + 1);
	}
	await api(url, "chaos", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
	// A local server without STARTTLS must fail required upgrade; no certificate bypass.
	const requiredTls = createEmail({ ...config, security: "starttls" });
	try { await assert.rejects(requiredTls.verifyEmailTransport(), error => error instanceof EmailError && (error.code === "tls" || error.code === "permanent-rejection")); } finally { requiredTls.close(); }
	const authenticated = createEmail({ ...config, user: "fixture-user", password: "fixture-password" });
	await api(url, "chaos", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Authentication: { ErrorCode: 535, Probability: 100 } }) });
	try { await assert.rejects(authenticated.verifyEmailTransport(), error => error instanceof EmailError && error.code === "authentication" && !error.retryable); } finally { authenticated.close(); }
	await api(url, "chaos", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
	const unavailable = createEmail({ ...config, port: await freePort() });
	try { await assert.rejects(unavailable.verifyEmailTransport(), error => error instanceof EmailError && error.code === "connection"); } finally { unavailable.close(); }
	if (process.argv.includes("--reference")) {
		const child = spawnSync(process.execPath, ["scripts/email-auth-smoke.ts"], { env: { ...process.env, ...environment, MAGIC_LINK_ENABLED: "true" }, stdio: "inherit" });
		assert.equal(child.status, 0, "Real Better Auth SMTP fixture failed");
	}
	if (process.argv.includes("--production")) {
		const child = spawnSync(process.execPath, ["scripts/email-production-smoke.ts", `${project}_default`], { env: { ...process.env, ...environment }, stdio: "inherit" });
		assert.equal(child.status, 0, "Production SMTP fixture failed");
	}
	console.info("Email SMTP/MIME, Bcc privacy, partial acceptance, bounds and deterministic 451/550 Chaos passed");
} finally {
	email.close(); for (const socket of sockets) socket.destroy();
	await new Promise<void>(resolve => tap.close(() => resolve()));
	docker([...compose, "down", "--volumes", "--remove-orphans"], overrides);
}
