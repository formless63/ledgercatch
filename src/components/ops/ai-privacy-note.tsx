/**
 * Risk 12 disclosure: shown wherever AI extraction can run ("Track this
 * page", generic/email captures). States what leaves the server and where.
 */
import { IconShieldLock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { getAiDisclosure } from "#/features/ops/ops.functions";
import { cn } from "#/lib/utils";

export function AiPrivacyNote({
	className,
	compact = false,
}: {
	className?: string;
	/** One-line variant for drawers. */
	compact?: boolean;
}) {
	const query = useQuery({
		queryKey: ["ops", "ai-disclosure"],
		queryFn: () => getAiDisclosure(),
		staleTime: 5 * 60_000,
	});
	const info = query.data;
	if (!info) return null;

	const where = info.host ? (
		<code className="font-mono">{info.host}</code>
	) : (
		"an invalid AI_BASE_URL"
	);
	const tone = !info.configured
		? "border-border bg-muted/40"
		: info.local
			? "border-emerald-500/30 bg-emerald-500/8"
			: "border-amber-500/30 bg-amber-500/8";

	if (compact)
		return (
			<p
				className={cn(
					"flex items-start gap-1.5 rounded-sm border px-2 py-1 text-[11px] text-muted-foreground",
					tone,
					className,
				)}
			>
				<IconShieldLock className="mt-px size-3.5 shrink-0" />
				{info.configured ? (
					<span>
						AI extraction sends this page's text (emails, phone and card numbers
						redacted; no screenshot) to {where}
						{info.local
							? " (local)."
							: ". Names and addresses are not redacted."}
					</span>
				) : (
					<span>AI extraction is off; nothing is sent to a model.</span>
				)}
			</p>
		);

	return (
		<div
			className={cn(
				"flex gap-2 rounded border px-3 py-2 text-xs leading-relaxed",
				tone,
				className,
			)}
		>
			<IconShieldLock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div className="space-y-1">
				<div className="font-semibold">AI extraction and your data</div>
				{info.configured ? (
					<p>
						When no deterministic parser recognizes a page ("Track this page",
						unknown stores, receipt emails and documents), the server sends the
						page URL and title, your note, and up to 60,000 characters of its
						visible text to {where}
						{info.usesDefaultEndpoint ? " (provider default)" : ""}. Email
						addresses, phone numbers and full card numbers are redacted first
						(the last 4 digits are kept). Names and street addresses are not
						redacted. Screenshots and the files themselves (PDFs, images) are
						never sent; for uploaded documents only their extracted text is. The
						API key stays on the server.
					</p>
				) : (
					<p>
						AI extraction is not configured (no <code>AI_MODEL</code>), so no
						page text is sent to a model. Unrecognized pages wait in Captures as
						"needs review".
					</p>
				)}
				{(!info.configured || !info.local) && (
					<p className="text-muted-foreground">
						For privacy, use a local OpenAI-compatible model such as Ollama or
						LM Studio: set <code>AI_BASE_URL</code> to its <code>/v1</code>{" "}
						endpoint and <code>AI_MODEL</code> to the model name. See
						docs/GETTING-STARTED.md.
					</p>
				)}
			</div>
		</div>
	);
}
