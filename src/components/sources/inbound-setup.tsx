/** Webhook URL (shown once) + ready-to-paste forwarder snippets. */
import { IconAlertTriangle, IconMail } from "@tabler/icons-react";
import { Callout, CopyButton, SecretBox } from "#/components/settings/ui";

export function cloudflareWorkerSnippet(url: string) {
	return `// Cloudflare → Email → Email Routing → Email Workers → Create
// Then route an address (e.g. orders@yourdomain) to this worker.
export default {
  async email(message, env, ctx) {
    const res = await fetch("${url}", {
      method: "POST",
      body: message.raw,
      headers: { "content-type": "message/rfc822" },
    });
    if (!res.ok) message.setReject(\`LedgerCatch rejected email: \${res.status}\`);
  },
};
`;
}

export function curlSnippet(url: string) {
	return `curl -sS --fail -X POST -H 'content-type: message/rfc822' --data-binary @- '${url}'`;
}

function CodeBlock({ code, label }: { code: string; label: string }) {
	return (
		<div className="relative">
			<pre className="max-h-72 overflow-auto rounded-sm border border-border bg-background p-2 pr-20 font-mono text-[11px] leading-relaxed">
				{code}
			</pre>
			<div className="absolute top-1.5 right-1.5">
				<CopyButton value={code} label={label} size="xs" />
			</div>
		</div>
	);
}

/**
 * `url` is the full webhook URL including the token — only available right
 * after creation/rotation. Without it, snippets show a placeholder.
 */
export function InboundSetup({ url, base }: { url?: string; base: string }) {
	const shown = url ?? `${base}/<token>`;
	return (
		<div className="space-y-3 text-xs">
			{url ? (
				<Callout
					tone="warning"
					icon={<IconAlertTriangle />}
					title="Copy this URL now — the token is shown only once"
				>
					<SecretBox value={url} label="Webhook URL" />
					<p>
						Anyone with this URL can add emails to your captures. Rotate the
						token if it leaks.
					</p>
				</Callout>
			) : (
				<Callout tone="info" icon={<IconMail />}>
					The token is stored hashed and cannot be shown again. Use{" "}
					<strong>Rotate token</strong> to get a new URL (the old one stops
					working).
				</Callout>
			)}
			<section className="space-y-1.5">
				<h3 className="label-caps">Cloudflare Email Routing worker</h3>
				<p className="text-muted-foreground">
					Free and the easiest “forward to an address” setup: route{" "}
					<code>orders@yourdomain</code> to this Email Worker, then forward
					confirmations there (or add a Gmail filter that auto-forwards store
					emails).
				</p>
				<CodeBlock code={cloudflareWorkerSnippet(shown)} label="Copy worker" />
			</section>
			<section className="space-y-1.5">
				<h3 className="label-caps">Other forwarders</h3>
				<ul className="list-disc space-y-1 pl-4 text-muted-foreground">
					<li>
						<strong>Mailgun</strong> route → forward to the URL plus{" "}
						<code>?format=mime</code> (a URL ending in “mime” makes Mailgun post
						the raw message as <code>body-mime</code>);{" "}
						<strong>SendGrid</strong> Inbound Parse with “POST the raw, full
						MIME message”; <strong>Postmark</strong> inbound with “include raw
						email” (JSON <code>RawEmail</code>).
					</li>
					<li>
						<strong>fetchmail / getmail / procmail</strong>: pipe each message
						to curl:
					</li>
				</ul>
				<CodeBlock code={curlSnippet(shown)} label="Copy curl" />
				<p className="text-muted-foreground">
					Limit 25 MB per message. Duplicates (same Message-ID) are ignored.
					Each email shows up under Captures and is parsed in the background.
				</p>
			</section>
		</div>
	);
}
