import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import {
	address,
	type EmailAddress,
	type EmailConfig,
	header,
	resolveEmailConfig,
	validateEmailConfig,
} from "./config.server";
import { EmailError, emailError } from "./errors.server";

export type { EmailAddress, EmailConfig } from "./config.server";
export { resolveEmailConfig, validateEmailConfig } from "./config.server";
export { EmailError, emailError } from "./errors.server";

export interface EmailMessage {
	to: EmailAddress[];
	cc?: EmailAddress[];
	bcc?: EmailAddress[];
	replyTo?: EmailAddress;
	subject: string;
	text?: string;
	html?: string;
}
export interface EmailDelivery {
	outcome: "accepted" | "partial" | "rejected";
	accepted: number;
	rejected: number;
	messageId: string;
}
export interface EmailOperation {
	operation: "send" | "verify";
	security: EmailConfig["security"];
	recipientCount: number;
}
export type EmailOperationHook = <T>(
	operation: EmailOperation,
	work: () => Promise<T>,
) => Promise<T>;
export function smtpOptions(
	config: EmailConfig,
): SMTPTransport.Options & { maxRecipients: number } {
	return {
		host: config.host,
		port: config.port,
		secure: config.security === "tls",
		requireTLS: config.security === "starttls",
		// Explicit credentials must be exercised even if the peer omits AUTH.
		forceAuth: Boolean(config.user),
		...(config.user && config.password
			? { auth: { user: config.user, pass: config.password } }
			: {}),
		connectionTimeout: 5000,
		greetingTimeout: 5000,
		socketTimeout: 10000,
		dnsTimeout: 5000,
		disableFileAccess: true,
		disableUrlAccess: true,
		maxRecipients: config.maxRecipients,
	};
}
export function validateMessage(message: EmailMessage, config: EmailConfig) {
	if (
		!message ||
		Object.keys(message).some(
			(key) =>
				!["to", "cc", "bcc", "replyTo", "subject", "text", "html"].includes(
					key,
				),
		) ||
		!header(message.subject, 200)
	)
		throw new EmailError("message");
	const recipients = (items: EmailAddress[] | undefined) => {
		if (items === undefined) return [];
		if (!Array.isArray(items)) throw new EmailError("message");
		return items.map(address);
	};
	const to = recipients(message.to),
		cc = recipients(message.cc),
		bcc = recipients(message.bcc);
	const count = to.length + cc.length + bcc.length;
	if (!count || count > config.maxRecipients) throw new EmailError("message");
	for (const body of [message.text, message.html])
		if (
			body !== undefined &&
			(typeof body !== "string" ||
				Buffer.byteLength(body) > 1024 * 1024 ||
				body.includes("\0"))
		)
			throw new EmailError("message");
	if (
		Buffer.byteLength(message.text ?? "") +
			Buffer.byteLength(message.html ?? "") >
		1024 * 1024
	)
		throw new EmailError("message");
	if (!message.text && !message.html) throw new EmailError("message");
	return {
		from: config.from,
		to,
		cc,
		bcc,
		replyTo: message.replyTo ? address(message.replyTo) : config.replyTo,
		subject: message.subject,
		...(message.text !== undefined ? { text: message.text } : {}),
		...(message.html !== undefined ? { html: message.html } : {}),
		disableFileAccess: true,
		disableUrlAccess: true,
		attachDataUrls: false,
	};
}
export function createEmail(
	config?: EmailConfig,
	observe?: EmailOperationHook,
) {
	let transporter:
		| ReturnType<
				typeof nodemailer.createTransport<SMTPTransport.SentMessageInfo>
		  >
		| undefined;
	let resolved: EmailConfig | undefined,
		closed = false;
	const ready = () => {
		if (closed) throw new EmailError("configuration");
		resolved ??= config ? validateEmailConfig(config) : resolveEmailConfig();
		transporter ??= nodemailer.createTransport(smtpOptions(resolved));
		return { config: resolved, transport: transporter };
	};
	async function perform<T>(
		operation: EmailOperation,
		work: () => Promise<T>,
	): Promise<T> {
		const safe = async () => {
			try {
				return await work();
			} catch (error) {
				throw emailError(error);
			}
		};
		return observe ? observe(operation, safe) : safe();
	}
	return {
		async verifyEmailTransport() {
			const { config, transport } = ready();
			return perform(
				{ operation: "verify", security: config.security, recipientCount: 0 },
				async () => {
					await transport.verify();
					return { verified: true as const };
				},
			);
		},
		async sendEmail(message: EmailMessage): Promise<EmailDelivery> {
			const { config, transport } = ready();
			const mail = validateMessage(message, config);
			return perform(
				{
					operation: "send",
					security: config.security,
					recipientCount: mail.to.length + mail.cc.length + mail.bcc.length,
				},
				async () => {
					// Exactly one attempt. A connection failure after acceptance is ambiguous.
					const result = await transport.sendMail(mail);
					const accepted = result.accepted.length,
						rejected = result.rejected.length;
					return {
						outcome:
							accepted === 0 ? "rejected" : rejected ? "partial" : "accepted",
						accepted,
						rejected,
						messageId: result.messageId,
					};
				},
			);
		},
		close() {
			transporter?.close();
			transporter = undefined;
			closed = true;
		},
	};
}
let singleton: ReturnType<typeof createEmail> | undefined;
export function getEmail() {
	singleton ??= createEmail();
	return singleton;
}
export function closeEmail() {
	singleton?.close();
	singleton = undefined;
}
export const sendEmail = (message: EmailMessage) =>
	getEmail().sendEmail(message);
export const verifyEmailTransport = () => getEmail().verifyEmailTransport();
// Non-pooled SMTP closes each session; this also releases singleton state at normal exit.
process.once("beforeExit", closeEmail);
