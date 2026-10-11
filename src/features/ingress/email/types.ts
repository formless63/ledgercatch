import type { EmailAddress } from "#/features/parsing/email/types";

/** captures.body_json for kind "email" (version 1). */
export type EmailCaptureBody = {
	version: 1;
	/** Original sender (the forwarded message's when forwarded). */
	from: EmailAddress | null;
	to: string[];
	subject: string;
	/** ISO date-time of the original message. */
	date: string | null;
	messageId: string;
	/** Null when larger than 1 MB — captures.body_text always has the HTML. */
	html: string | null;
	text: string | null;
	attachments: Array<{
		documentId: string;
		fileName: string;
		contentType: string;
		size: number;
	}>;
	forwarded: {
		by: EmailAddress | null;
		subject: string;
		date?: string;
		via: "attachment" | "inline";
	} | null;
	channel: {
		via: "imap" | "webhook" | "upload";
		sourceId?: string;
		mailbox?: string;
		uid?: number;
	};
};
