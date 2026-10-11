import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type EmailConfig,
	resolveEmailConfig,
	validateEmailConfig,
} from "./config.server";
import {
	createEmail,
	type EmailMessage,
	smtpOptions,
	validateMessage,
} from "./email.server";
import { EmailError, emailError } from "./errors.server";
import { renderMagicLinkEmail } from "./magic-link.server";

const env = {
	SMTP_HOST: "localhost",
	SMTP_PORT: "1025",
	SMTP_SECURITY: "opportunistic",
	EMAIL_FROM_ADDRESS: "sender@example.test",
};
const config = resolveEmailConfig(env);
const message: EmailMessage = {
	to: [{ address: "to@example.test", name: "Recipient" }],
	subject: "Hello 世界",
	text: "Text ☕",
	html: "<p>Hello</p>",
};
describe("Email configuration and safety", () => {
	it("is lazy until an operation and closes without opening SMTP", async () => {
		const email = createEmail({} as EmailConfig);
		await assert.rejects(email.verifyEmailTransport(), {
			code: "configuration",
		});
		email.close();
		await assert.rejects(email.sendEmail(message), {
			code: "configuration",
		});
	});
	it("resolves complete explicit configuration and optional reply-to", () => {
		assert.strictEqual(config.maxRecipients, 50);
		assert.partialDeepStrictEqual(
			resolveEmailConfig({
				...env,
				SMTP_USER: "user",
				SMTP_PASSWORD: "password",
				EMAIL_REPLY_TO_ADDRESS: "reply@example.test",
				EMAIL_REPLY_TO_NAME: "Replies",
			}),
			{
				user: "user",
				replyTo: { address: "reply@example.test", name: "Replies" },
			},
		);
	});
	it("rejects partial credentials, invalid port/security/from and control characters", () => {
		for (const changes of [
			{ SMTP_USER: "user" },
			{ SMTP_PASSWORD: "password" },
			{ SMTP_PORT: "0" },
			{ SMTP_PORT: "65536" },
			{ SMTP_PORT: "1.5" },
			{ SMTP_PORT: "bad" },
			{ SMTP_SECURITY: "auto" },
			{ SMTP_SECURITY: "" },
			{ EMAIL_FROM_ADDRESS: "" },
			{ EMAIL_FROM_ADDRESS: "a@example.test\r\nBcc:x" },
			{ EMAIL_FROM_NAME: "bad\nname" },
			{ EMAIL_REPLY_TO_NAME: "no address" },
			{ EMAIL_MAX_RECIPIENTS: "101" },
			{ EMAIL_MAX_RECIPIENTS: "0" },
		])
			assert.throws(
				() => resolveEmailConfig({ ...env, ...changes }),
				EmailError,
			);
		assert.throws(() => resolveEmailConfig({}), EmailError);
	});
	it("maps TLS modes explicitly independent of port with secure bounded transport", () => {
		for (const [security, secure, requireTLS] of [
			["tls", true, false],
			["starttls", false, true],
			["opportunistic", false, false],
		] as const) {
			const options = smtpOptions({ ...config, security, port: 465 });
			assert.partialDeepStrictEqual(options, {
				secure,
				requireTLS,
				disableFileAccess: true,
				disableUrlAccess: true,
				maxRecipients: 50,
				connectionTimeout: 5000,
				greetingTimeout: 5000,
				socketTimeout: 10000,
				dnsTimeout: 5000,
			});
			assert.strictEqual(options.tls, undefined);
			assert.strictEqual(options.pool, undefined);
			assert.strictEqual(options.forceAuth, false);
		}
		assert.strictEqual(
			smtpOptions({ ...config, user: "user", password: "password" }).forceAuth,
			true,
		);
		assert.throws(
			() =>
				validateEmailConfig({
					...config,
					tls: { rejectUnauthorized: false },
				} as EmailConfig),
			EmailError,
		);
	});
	it("accepts structured text, HTML, Unicode, cc/bcc and configured sender", () => {
		for (const content of [
			{ text: "Text", html: undefined },
			{ text: undefined, html: "<p>HTML</p>" },
			{ text: "text", html: "<p>HTML</p>" },
		])
			assert.deepStrictEqual(
				validateMessage({ ...message, ...content }, config).from,
				config.from,
			);
		assert.partialDeepStrictEqual(
			validateMessage(
				{
					...message,
					cc: [{ address: "cc@example.test" }],
					bcc: [{ address: "bcc@example.test" }],
				},
				config,
			),
			{
				disableFileAccess: true,
				disableUrlAccess: true,
				attachDataUrls: false,
			},
		);
	});
	it("enforces combined UTF-8 size and exact subject boundary", () => {
		assert.doesNotThrow(() =>
			validateMessage({ ...message, subject: "x".repeat(200) }, config),
		);
		assert.throws(
			() =>
				validateMessage(
					{ ...message, text: "x".repeat(600000), html: "x".repeat(600000) },
					config,
				),
			EmailError,
		);
	});
	it("bounds input and rejects injection and unsupported content resolution", () => {
		for (const changes of [
			{ to: [] },
			{
				to: Array.from({ length: 51 }, () => ({ address: "to@example.test" })),
			},
			{ subject: "x".repeat(201) },
			{ subject: "bad\r\nheader" },
			{ text: undefined, html: undefined },
			{ text: "x".repeat(1024 * 1024 + 1) },
			{ html: "x".repeat(1024 * 1024 + 1) },
			{ to: [{ address: "bad\n@example.test" }] },
			{ to: [{ address: "ok@example.test", name: "bad\u0001" }] },
			{ replyTo: { address: "bad\r@example.test" } },
		])
			assert.throws(
				() => validateMessage({ ...message, ...changes }, config),
				EmailError,
			);
		for (const key of [
			"raw",
			"path",
			"href",
			"headers",
			"envelope",
			"attachments",
			"dkim",
			"from",
			"attachDataUrls",
		])
			assert.throws(
				() => validateMessage({ ...message, [key]: "untrusted" }, config),
				EmailError,
			);
		for (const key of ["path", "href"])
			assert.throws(
				() =>
					validateMessage(
						{
							...message,
							text: { [key]: "https://untrusted.invalid" },
						} as unknown as EmailMessage,
						config,
					),
				EmailError,
			);
	});
});
describe("Email errors and magic-link rendering", () => {
	it("classifies failures conservatively and serializes only safe data", () => {
		for (const [input, code, retryable] of [
			[{ responseCode: 451 }, "temporary-rejection", true],
			[{ code: "EAUTH", responseCode: 454 }, "authentication", false],
			[{ responseCode: 550 }, "permanent-rejection", false],
			[{ code: "EAUTH", responseCode: 535 }, "authentication", false],
			[{ code: "ECONNREFUSED" }, "connection", true],
			[{ code: "ECONNRESET" }, "connection", false],
			[{ code: "ETIMEDOUT" }, "timeout", false],
			[{ code: "ETLS" }, "tls", false],
			[{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls", false],
			[{ code: "EMESSAGE" }, "message", false],
			[{}, "unknown", false],
		] as const) {
			const cause = {
				...input,
				message: "password token recipient@example.test private body",
			};
			const safe = emailError(cause);
			assert.strictEqual(safe.code, code);
			assert.strictEqual(safe.retryable, retryable);
			assert.strictEqual(safe.cause, cause);
			assert.doesNotMatch(
				JSON.stringify(safe),
				/password|token|recipient@|private body/,
			);
		}
	});
	it("escapes HTML, keeps plain text and accepts only canonical HTTP origins", () => {
		const url =
			"https://app.example.test/api/auth/magic-link/verify?token=opaque&callbackURL=%2F";
		const rendered = renderMagicLinkEmail({
			appName: "<Starter> & Friends",
			url,
			appBaseUrl: "https://app.example.test",
		});
		assert.ok(rendered.text.includes(url));
		assert.ok(rendered.html.includes("&lt;Starter&gt; &amp; Friends"));
		assert.ok(rendered.html.includes("&amp;callbackURL"));
		assert.doesNotMatch(rendered.html, /<img|<style|<script/);
		for (const unsafe of [
			"https://evil.invalid/",
			"javascript:alert(1)",
			"https://user:pass@app.example.test/",
		])
			assert.throws(
				() =>
					renderMagicLinkEmail({
						appName: "Starter",
						url: unsafe,
						appBaseUrl: "https://app.example.test",
					}),
				EmailError,
			);
	});
});
