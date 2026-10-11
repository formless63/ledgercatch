import type { StoreId } from "#/shared/capture";
import type { ParseResult } from "../types";

export type EmailAddress = { name?: string; address: string };

/**
 * What the email parsers see: the *original* message (when the user forwarded
 * a confirmation, `from`/`subject`/`date` are the forwarded message's, not the
 * forwarder's). Pure data — no attachments' bytes.
 */
export type EmailMessage = {
	/** Store detected from sender/subject/body (see detectStoreFromSender). */
	source: StoreId;
	messageId: string;
	from: EmailAddress | null;
	subject: string;
	/** ISO date-time of the (original) message. */
	date?: string;
	html?: string;
	text?: string;
	attachments: Array<{ fileName: string; contentType: string }>;
};

export type EmailParseOutcome = {
	result: ParseResult;
	parserId: string;
	version: number;
};
