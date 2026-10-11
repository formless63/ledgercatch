import { header } from "./config.server";
import { EmailError } from "./errors.server";

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				char
			] ?? char,
	);
export function renderMagicLinkEmail(input: {
	appName: string;
	url: string;
	appBaseUrl: string;
}) {
	let link: URL;
	try {
		link = new URL(input.url);
		const canonical = new URL(input.appBaseUrl);
		if (
			!["http:", "https:"].includes(canonical.protocol) ||
			link.origin !== canonical.origin ||
			link.username ||
			link.password ||
			!header(input.appName, 128) ||
			canonical.username ||
			canonical.password
		)
			throw new Error();
	} catch {
		throw new EmailError("message");
	}
	const name = escapeHtml(input.appName),
		href = escapeHtml(link.href);
	return {
		subject: `Sign in to ${input.appName}`,
		text: `Sign in to ${input.appName}\n\n${link.href}\n\nIf you did not request this link, ignore this message.`,
		html: `<!doctype html><html lang="en"><body><h1>Sign in to ${name}</h1><p><a href="${href}">Sign in to ${name}</a></p><p>If you did not request this link, ignore this message.</p></body></html>`,
	};
}
