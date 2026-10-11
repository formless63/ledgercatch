/**
 * Raw MIME → normalized email (mailparser). Handles forwarded confirmations:
 * an attached original (message/rfc822) or an inline forward block from
 * Gmail / Outlook / Apple Mail / Thunderbird, so store detection and parsing
 * see the original sender, subject and date — not the forwarder's.
 */
import { type AddressObject, simpleParser } from "mailparser";
import { parseDate } from "#/features/parsing/dates";
import { detectStoreFromSender } from "#/features/parsing/email/detect";
import type { EmailAddress } from "#/features/parsing/email/types";
import type { StoreId } from "#/shared/capture";

/** Hard cap for one message (raw bytes), shared by IMAP and the webhook. */
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
const MAX_HTML_CHARS = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 512 * 1024;

export type MimeAttachment = {
	fileName: string;
	contentType: string;
	content: Uint8Array;
	size: number;
	/** Inline images (logos, tracking pixels) referenced from the HTML. */
	inline: boolean;
};

export type ForwardInfo = {
	/** Who forwarded it (the outer From). */
	by: EmailAddress | null;
	/** Outer subject ("Fwd: …"). */
	subject: string;
	date?: string;
	via: "attachment" | "inline";
};

export type ParsedMime = {
	/** Message-ID without angle brackets ("" when absent). */
	messageId: string;
	from: EmailAddress | null;
	to: string[];
	subject: string;
	/** ISO date-time. */
	date?: string;
	html?: string;
	text?: string;
	attachments: MimeAttachment[];
	forwarded?: ForwardInfo;
	source: StoreId;
};

function firstAddress(obj: AddressObject | undefined): EmailAddress | null {
	const value = obj?.value?.[0];
	if (!value?.address) return null;
	return {
		name: value.name || undefined,
		address: value.address.toLowerCase(),
	};
}

function addressList(
	obj: AddressObject | AddressObject[] | undefined,
): string[] {
	const list = Array.isArray(obj) ? obj : obj ? [obj] : [];
	return list.flatMap((o) =>
		o.value.flatMap((v) => (v.address ? [v.address.toLowerCase()] : [])),
	);
}

/** "Name <a@b>", "a@b", "Name [mailto:a@b]", "*Name* <a@b>" → address. */
export function parseAddressText(value: string): EmailAddress | null {
	const clean = value.replace(/\*/g, "").replace(/\s+/g, " ").trim();
	const m =
		/^(.*?)\s*[<[](?:mailto:)?([^\s<>[\]@]+@[^\s<>[\]]+)[>\]]/i.exec(clean) ??
		/^()([^\s<>@]+@[^\s<>]+)$/.exec(clean);
	if (!m?.[2]) return null;
	const name = (m[1] ?? "").replace(/^["']|["']$/g, "").trim();
	return { name: name || undefined, address: m[2].toLowerCase() };
}

function parseLooseDate(value: string): string | undefined {
	const cleaned = value
		.replace(/\*/g, "")
		.replace(/\s+at\s+/i, " ")
		.replace(/\s+/g, " ")
		.trim();
	const ms = Date.parse(cleaned);
	if (Number.isFinite(ms)) {
		const year = new Date(ms).getUTCFullYear();
		if (year > 1990 && year < 2100) return new Date(ms).toISOString();
	}
	const day = parseDate(cleaned);
	return day ? `${day}T12:00:00.000Z` : undefined;
}

const FORWARD_MARKERS = [
	/-{2,}\s*Forwarded message\s*-{2,}/i,
	/-{2,}\s*Original Message\s*-{2,}/i,
	/Begin forwarded message:/i,
	/-{2,}\s*Weitergeleitete Nachricht\s*-{2,}/i,
	/-{2,}\s*Message transféré\s*-{2,}/i,
	/_{8,}/,
];

const HEADER_LINE =
	/^\s*\*?\s*(From|Von|De|Date|Sent|Gesendet|Envoyé|Datum|Subject|Betreff|Objet|To|An|À|Cc|Reply-To)\s*\*?\s*:\s*\*?\s*(.*)$/i;

/**
 * Original From/Date/Subject from an inline forward block in plain text.
 * Returns undefined when no block with at least a From line is found.
 */
export function extractInlineForward(
	text: string,
	subjectLooksForwarded: boolean,
): { from: EmailAddress; subject?: string; date?: string } | undefined {
	let start = -1;
	for (const marker of FORWARD_MARKERS) {
		const m = marker.exec(text);
		if (m && (start < 0 || m.index < start)) start = m.index + m[0].length;
	}
	if (start < 0) {
		if (!subjectLooksForwarded) return undefined;
		const m = /^\s*\*?(?:From|Von|De)\*?\s*:/im.exec(text);
		if (!m) return undefined;
		start = m.index;
	}
	const lines = text.slice(start, start + 4000).split(/\r?\n/);
	const headers = new Map<string, string>();
	let seen = 0;
	let lastKey: string | undefined;
	for (const raw of lines) {
		const line = raw.replace(/^>\s?/, "");
		if (!line.trim()) {
			if (headers.size > 0 && seen > 2) break;
			continue;
		}
		const m = HEADER_LINE.exec(line);
		if (m?.[1]) {
			const key = m[1].toLowerCase();
			const norm =
				key === "von" || key === "de"
					? "from"
					: ["sent", "gesendet", "envoyé", "datum"].includes(key)
						? "date"
						: key === "betreff" || key === "objet"
							? "subject"
							: key;
			if (!headers.has(norm)) headers.set(norm, (m[2] ?? "").trim());
			lastKey = norm;
			seen++;
			continue;
		}
		// Wrapped header value (long subjects).
		if (lastKey && seen < 8 && headers.size > 0 && /^\s{1,}\S/.test(raw)) {
			headers.set(lastKey, `${headers.get(lastKey)} ${line.trim()}`);
			continue;
		}
		if (headers.size > 0) break;
		if (seen === 0 && lines.indexOf(raw) > 6) break;
	}
	const from = headers.get("from")
		? parseAddressText(headers.get("from") as string)
		: null;
	if (!from) return undefined;
	const subject = headers.get("subject")?.replace(/\*/g, "").trim();
	const dateText = headers.get("date");
	return {
		from,
		subject: subject || undefined,
		date: dateText ? parseLooseDate(dateText) : undefined,
	};
}

function htmlToRoughText(html: string): string {
	return html
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h\d|blockquote|table)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

function toAttachments(
	list: Awaited<ReturnType<typeof simpleParser>>["attachments"],
): MimeAttachment[] {
	return list.map((a, index) => ({
		fileName:
			a.filename ||
			`attachment-${index + 1}.${(a.contentType.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "")}`,
		contentType: (a.contentType || "application/octet-stream").toLowerCase(),
		content: new Uint8Array(
			a.content.buffer,
			a.content.byteOffset,
			a.content.byteLength,
		),
		size: a.size ?? a.content.byteLength,
		inline: a.related === true || a.contentDisposition === "inline",
	}));
}

/**
 * ISO date keeping the sender's UTC offset from the raw Date header
 * ("…T17:22:10-07:00"), so the order date is the sender's calendar day.
 */
function headerDate(
	parsed: Awaited<ReturnType<typeof simpleParser>>,
): string | undefined {
	const date = parsed.date;
	if (!date || Number.isNaN(date.getTime())) return undefined;
	const line = parsed.headerLines?.find((h) => h.key === "date")?.line ?? "";
	const m = /([+-])(\d{2})(\d{2})\s*(?:\([^)]*\))?\s*$/.exec(line);
	if (!m) return date.toISOString();
	const sign = m[1] === "-" ? -1 : 1;
	const minutes = sign * (Number(m[2]) * 60 + Number(m[3]));
	if (Math.abs(minutes) > 14 * 60) return date.toISOString();
	const local = new Date(date.getTime() + minutes * 60_000)
		.toISOString()
		.replace(/\.\d{3}Z$/, "");
	return `${local}${m[1]}${m[2]}:${m[3]}`;
}

const PARSE_OPTIONS = {
	keepCidLinks: true,
	skipTextToHtml: true,
	maxHtmlLengthToParse: MAX_HTML_CHARS,
} as const;

export async function parseMimeMessage(raw: Uint8Array): Promise<ParsedMime> {
	const parsed = await simpleParser(Buffer.from(raw), PARSE_OPTIONS);
	const outerFrom = firstAddress(parsed.from);
	const outerSubject = parsed.subject ?? "";
	const outerDate = headerDate(parsed);
	let attachments = toAttachments(parsed.attachments);
	let html = typeof parsed.html === "string" ? parsed.html : undefined;
	let text = parsed.text ?? undefined;
	let from = outerFrom;
	let subject = outerSubject;
	let date = outerDate;
	let forwarded: ForwardInfo | undefined;
	const subjectLooksForwarded = /^\s*(?:fwd?|fw|wg|tr|rv)\s*:/i.test(
		outerSubject,
	);

	// Forward-as-attachment: the original is a message/rfc822 part.
	const attached = attachments.find((a) => a.contentType === "message/rfc822");
	const ownBody = (text ?? htmlToRoughText(html ?? "")).trim();
	if (attached && attached.size <= MAX_EMAIL_BYTES && ownBody.length < 4000) {
		const inner = await simpleParser(
			Buffer.from(attached.content),
			PARSE_OPTIONS,
		);
		const innerFrom = firstAddress(inner.from);
		if (innerFrom) {
			forwarded = {
				by: outerFrom,
				subject: outerSubject,
				date: outerDate,
				via: "attachment",
			};
			from = innerFrom;
			subject = inner.subject ?? subject;
			date = headerDate(inner) ?? date;
			html = typeof inner.html === "string" ? inner.html : undefined;
			text = inner.text ?? undefined;
			attachments = [
				...attachments.filter((a) => a !== attached),
				...toAttachments(inner.attachments),
			];
		}
	}

	if (!forwarded) {
		const body = text ?? htmlToRoughText(html ?? "");
		const inline = extractInlineForward(body, subjectLooksForwarded);
		if (inline && inline.from.address !== outerFrom?.address) {
			forwarded = {
				by: outerFrom,
				subject: outerSubject,
				date: outerDate,
				via: "inline",
			};
			from = inline.from;
			subject =
				inline.subject ??
				subject.replace(/^\s*(?:fwd?|fw|wg|tr|rv)\s*:\s*/i, "");
			date = inline.date ?? date;
		}
	}

	if (html && html.length > MAX_HTML_CHARS)
		html = html.slice(0, MAX_HTML_CHARS);
	if (text && text.length > MAX_TEXT_CHARS)
		text = text.slice(0, MAX_TEXT_CHARS);
	return {
		messageId: (parsed.messageId ?? "").replace(/^<|>$/g, "").trim(),
		from,
		to: addressList(parsed.to),
		subject,
		date,
		html,
		text,
		attachments,
		forwarded,
		source: detectStoreFromSender(from?.address, subject, html ?? text),
	};
}
