import {
	IconAlertTriangle,
	IconBrandChrome,
	IconDownload,
	IconKey,
	IconPlugConnected,
	IconRefresh,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { CAPTURE_STATUS_TONES, formatRelative } from "#/components/app/format";
import {
	Button,
	Kbd,
	PageHeader,
	Panel,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import {
	ApiKeyList,
	apiKeysQueryKey,
	isExtensionKey,
} from "#/components/settings/api-key-list";
import {
	Callout,
	CopyButton,
	errorText,
	SecretBox,
	SettingsNav,
} from "#/components/settings/ui";
import { ledgerKeys } from "#/features/ledger/hooks";
import { listCaptures } from "#/features/ledger/ledger.functions";
import { createApiKey } from "#/integrations/api-platform/api-keys.functions";
import { EXTENSION_PERMISSIONS } from "#/integrations/api-platform/permissions";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/app/settings/extension")({
	component: ExtensionPage,
});

const ZIP_PATH = "/downloads/ledgercatch-extension.zip";

function Step({
	n,
	title,
	done,
	children,
}: {
	n: number;
	title: ReactNode;
	done?: boolean;
	children: ReactNode;
}) {
	return (
		<li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
			<span
				className={cn(
					"grid size-6 place-items-center rounded-full border font-mono text-[11px] font-semibold",
					done
						? "border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
						: "border-border bg-muted text-muted-foreground",
				)}
			>
				{done ? "✓" : n}
			</span>
			<div className="min-w-0 pb-5">
				<h3 className="pt-0.5 text-[13px] font-semibold">{title}</h3>
				<div className="mt-1.5 space-y-2 text-xs text-muted-foreground">
					{children}
				</div>
			</div>
		</li>
	);
}

const STORES: Array<{
	source: string;
	mode: "snapshot" | "data";
	what: string;
}> = [
	{
		source: "amazon",
		mode: "snapshot",
		what: "Order list, details, print summary, thank-you page",
	},
	{
		source: "mouser",
		mode: "snapshot",
		what: "Order history and order detail pages",
	},
	{
		source: "alibaba",
		mode: "snapshot",
		what: "Order list and trade detail pages",
	},
	{
		source: "aliexpress",
		mode: "data",
		what: "Order list/detail and tracking responses",
	},
	{
		source: "ebay",
		mode: "data",
		what: "Purchase history API + order receipt page",
	},
	{
		source: "digikey",
		mode: "data",
		what: "Order history / invoice JSON",
	},
];

function useZipAvailable() {
	return useQuery({
		queryKey: ["extension-zip"],
		queryFn: async () => {
			const response = await fetch(ZIP_PATH, { method: "HEAD" });
			return response.ok;
		},
		staleTime: 5 * 60_000,
		retry: false,
	});
}

function ExtensionPage() {
	const client = useQueryClient();
	const zip = useZipAvailable();
	const [origin, setOrigin] = useState("");
	const [secret, setSecret] = useState<string | null>(null);
	useEffect(() => setOrigin(window.location.origin), []);

	const captures = useQuery({
		queryKey: ledgerKeys.captures({ limit: 10, purpose: "extension-check" }),
		queryFn: () => listCaptures({ data: { limit: 10 } }),
		refetchInterval: 10_000,
	});
	const recent = captures.data?.captures ?? [];
	const last = recent[0];
	const live =
		last && Date.now() - new Date(last.receivedAt).getTime() < 15 * 60_000;

	const createKey = useMutation({
		mutationFn: () =>
			createApiKey({
				data: {
					name: `Browser extension (${new Date().toISOString().slice(0, 10)})`,
					permissions: {
						captures: [...EXTENSION_PERMISSIONS.captures],
						orders: [...EXTENSION_PERMISSIONS.orders],
					},
					expiresInDays: null,
				},
			}),
		onSuccess: async (result) => {
			setSecret(result.secret);
			toast.success("Extension key created — copy it now");
			await client.invalidateQueries({ queryKey: apiKeysQueryKey });
		},
		onError: (error) => toast.error(errorText(error)),
	});

	return (
		<div className="pb-10">
			<PageHeader
				title="Browser extension"
				description="Captures orders and invoices while you browse your store accounts."
				actions={
					<span className="flex items-center gap-2 text-xs">
						<span
							className={cn(
								"size-2 rounded-full",
								live
									? "bg-emerald-500"
									: last
										? "bg-amber-500"
										: "bg-muted-foreground/50",
							)}
						/>
						<span className="font-mono text-muted-foreground">
							{last
								? `Last capture ${formatRelative(last.receivedAt)}`
								: "No captures yet"}
						</span>
					</span>
				}
			/>
			<SettingsNav />
			<div className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
				<Panel title="Install & connect · Chrome / Brave">
					<ol>
						<Step n={1} title="Download the extension">
							{zip.data === false ? (
								<Callout tone="warning" icon={<IconAlertTriangle />}>
									<p>
										No prebuilt zip is published on this server yet. Build it
										from the repo:
									</p>
									<code className="block rounded-sm bg-background px-2 py-1 font-mono text-[11px] text-foreground">
										cd extension && bun install && bun run zip
									</code>
									<p>
										Then unzip <code>extension/.output/*-chrome.zip</code> (or
										load <code>extension/.output/chrome-mv3</code> directly).
									</p>
								</Callout>
							) : (
								<a
									href={ZIP_PATH}
									download
									className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90"
								>
									<IconDownload className="size-3.5" />{" "}
									ledgercatch-extension.zip
								</a>
							)}
							<p>
								Unzip it into a folder you'll keep (the browser loads it from
								there).
							</p>
						</Step>
						<Step n={2} title="Load it unpacked">
							<ol className="list-decimal space-y-1 pl-4">
								<li>
									Open{" "}
									<span className="inline-flex flex-wrap items-center gap-1">
										<code className="text-foreground">chrome://extensions</code>
										<CopyButton size="xs" value="chrome://extensions" />
									</span>{" "}
									or{" "}
									<span className="inline-flex flex-wrap items-center gap-1">
										<code className="text-foreground">brave://extensions</code>
										<CopyButton size="xs" value="brave://extensions" />
									</span>{" "}
									in a new tab (browsers block clicking these links).
								</li>
								<li>
									Turn on <strong>Developer mode</strong> (top-right toggle).
								</li>
								<li>
									Click <strong>Load unpacked</strong> and select the unzipped
									folder (the one containing <code>manifest.json</code>).
								</li>
								<li>
									Pin it from the puzzle-piece menu so the status badge is
									visible. The options page opens automatically.
								</li>
							</ol>
						</Step>
						<Step n={3} title="Create an extension key" done={Boolean(secret)}>
							<p>
								A dedicated key with only <code>captures:write</code> and{" "}
								<code>orders:read</code>, no expiry. Revoke it any time below.
							</p>
							{secret ? (
								<div className="space-y-1.5 rounded-sm border border-primary/40 bg-primary/5 p-2">
									<div className="flex items-center justify-between">
										<span className="font-semibold text-foreground">
											Copy this key now — it is shown only once
										</span>
										<Button
											size="xs"
											variant="ghost"
											aria-label="Dismiss key"
											onClick={() => setSecret(null)}
										>
											<IconX />
										</Button>
									</div>
									<SecretBox label="Extension API key" value={secret} />
								</div>
							) : (
								<Button
									variant="primary"
									disabled={createKey.isPending}
									onClick={() => createKey.mutate()}
								>
									<IconKey /> Create extension key
								</Button>
							)}
						</Step>
						<Step
							n={4}
							title="Paste server URL and key in the extension options"
						>
							<SecretBox label="Server URL" value={origin || "…"} />
							<p>
								Click <strong>Save &amp; test connection</strong> and allow
								access to this site when the browser asks. The header pill
								should read <strong>Connected</strong>.
							</p>
						</Step>
						<Step n={5} title="Browse your orders" done={Boolean(last)}>
							<p>
								Open your order history on any supported store. New captures
								appear on the right within seconds.
							</p>
						</Step>
					</ol>
				</Panel>

				<div className="space-y-4">
					<Panel
						title="Live capture check"
						action={
							<span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
								<IconRefresh
									className={cn(
										"size-3",
										captures.isFetching && "animate-spin",
									)}
								/>
								10s
							</span>
						}
						bodyClassName="p-0"
					>
						{captures.isError ? (
							<p className="p-3 text-xs text-red-600 dark:text-red-400">
								{errorText(captures.error)}
							</p>
						) : recent.length === 0 ? (
							<div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-xs text-muted-foreground">
								<IconPlugConnected className="size-5" />
								Waiting for the first capture…
							</div>
						) : (
							<ul className="divide-y divide-border">
								{recent.map((capture) => (
									<li
										key={capture.id}
										className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-xs"
									>
										<StoreMark
											source={capture.source}
											className="text-[11px]"
										/>
										<span className="min-w-0">
											<span className="block truncate">
												{capture.pageTitle || capture.pageUrl || capture.kind}
											</span>
											<span className="block truncate font-mono text-[10px] text-muted-foreground">
												{capture.kind} · {capture.trigger}
												{capture.ordersFound
													? ` · ${capture.ordersFound} orders`
													: ""}
											</span>
										</span>
										<span className="flex flex-col items-end gap-0.5">
											<Tag
												tone={CAPTURE_STATUS_TONES[capture.status] ?? "neutral"}
											>
												{capture.status.replace("_", " ")}
											</Tag>
											<span className="font-mono text-[10px] text-muted-foreground">
												{formatRelative(capture.receivedAt)}
											</span>
										</span>
									</li>
								))}
							</ul>
						)}
					</Panel>

					<Panel title="What gets captured">
						<div className="space-y-3 text-xs">
							<ul className="divide-y divide-border">
								{STORES.map((store) => (
									<li
										key={store.source}
										className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 py-1"
									>
										<StoreMark source={store.source} className="text-[11px]" />
										<span className="flex min-w-0 flex-wrap items-center gap-1.5">
											<Tag tone={store.mode === "data" ? "info" : "neutral"}>
												{store.mode === "data"
													? "intercepted data"
													: "page snapshot"}
											</Tag>
											<span className="text-[11px] text-muted-foreground">
												{store.what}
											</span>
										</span>
									</li>
								))}
							</ul>
							<p className="text-[11px] text-muted-foreground">
								<strong>Page snapshots</strong> save the rendered order page
								once it settles. <strong>Intercepted data</strong> reads the
								JSON the store's own page already fetched — nothing extra is
								requested. Both are parsed on this server, so parser fixes apply
								retroactively.
							</p>
							<dl className="space-y-2">
								<div>
									<dt className="font-semibold">Track this page</dt>
									<dd className="text-muted-foreground">
										Any other store: open the order/confirmation page and click
										<em> Track this page</em> in the popup. The page text is
										extracted with AI and lands in your inbox.
									</dd>
								</div>
								<div>
									<dt className="font-semibold">Save invoices</dt>
									<dd className="text-muted-foreground">
										From the popup on an order page: downloads the invoice /
										receipt PDF (or prints the HTML invoice) and attaches it to
										the matching order.
									</dd>
								</div>
								<div>
									<dt className="font-semibold">Recorder mode</dt>
									<dd className="text-muted-foreground">
										Options → Passive capture. Sends every JSON response and
										page on supported stores — use briefly to collect fixtures
										when a parser misses something, then switch it off.
									</dd>
								</div>
							</dl>
							<p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
								Toolbar badge: <Tag tone="primary">3</Tag> pending uploads,{" "}
								<Tag tone="danger">2</Tag> failed, <Tag tone="warning">!</Tag>{" "}
								key rejected. After updating the extension, reload it on{" "}
								<Kbd>extensions</Kbd> and refresh open store tabs.
							</p>
						</div>
					</Panel>

					<Panel
						title="Extension keys"
						action={
							<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
								<IconBrandChrome className="size-3" /> captures:write
							</span>
						}
					>
						<ApiKeyList
							filter={isExtensionKey}
							emptyText="No extension keys yet — create one in step 3."
						/>
					</Panel>
				</div>
			</div>
		</div>
	);
}
