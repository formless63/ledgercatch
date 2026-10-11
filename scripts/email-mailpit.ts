// API is used only to inspect captured SMTP messages, never to submit mail.
export interface CapturedEmail {
	ID: string; Subject: string; Text: string; HTML: string; MessageID: string;
	From: { Address: string; Name: string };
	To: { Address: string }[]; Cc: { Address: string }[]; Bcc: { Address: string }[]; ReplyTo: { Address: string }[];
	Attachments: unknown[]; Inline: unknown[];
}
export async function api(url: string, path: string, init?: RequestInit) {
	const response = await fetch(`${url}/api/v1/${path}`, init);
	if (!response.ok) throw new Error("Mailpit assertion API failed");
	return response;
}
export async function captured(url: string, matches: (message: { Subject: string; To: { Address: string }[] }) => boolean): Promise<CapturedEmail> {
	for (let i = 0; i < 40; i++) {
		const list = await (await api(url, "messages")).json() as { messages: { ID: string; Subject: string; To: { Address: string }[] }[] };
		const item = list.messages.find(matches);
		if (item) return (await api(url, `message/${item.ID}`)).json() as Promise<CapturedEmail>;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("Expected SMTP capture missing");
}
