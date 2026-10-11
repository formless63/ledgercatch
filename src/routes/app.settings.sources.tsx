import {
	IconAlertTriangle,
	IconInbox,
	IconKey,
	IconPencil,
	IconPlayerPlay,
	IconPlus,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	PageHeader,
	Panel,
	Tag,
} from "#/components/app/primitives";
import {
	Callout,
	errorText,
	SettingsNav,
	Switch,
} from "#/components/settings/ui";
import { InboundSetup } from "#/components/sources/inbound-setup";
import {
	type CreatedSource,
	SourceForm,
	type SourceKindMeta,
	type SourceRow,
} from "#/components/sources/source-form";
import {
	deleteIngressSource,
	listIngressSources,
	pollIngressSourceNow,
	rotateIngressPushToken,
	testIngressSource,
	updateIngressSource,
} from "#/features/ingress/sources-ui.functions";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/app/settings/sources")({
	component: SourcesPage,
});

const SOURCES_KEY = ["ingress", "sources"] as const;

const STATUS_TONE = {
	ok: "success",
	error: "danger",
	untested: "neutral",
} as const;

function rel(value: Date | string | null | undefined) {
	if (!value) return null;
	return formatRelative(
		typeof value === "string" ? value : new Date(value).toISOString(),
	);
}

function SourceCard({
	source,
	meta,
	webhookBase,
	revealedUrl,
	onRevealed,
}: {
	source: SourceRow;
	meta?: SourceKindMeta;
	webhookBase: string;
	revealedUrl?: string;
	onRevealed: (url: string) => void;
}) {
	const client = useQueryClient();
	const refresh = () => client.invalidateQueries({ queryKey: SOURCES_KEY });
	const [editing, setEditing] = useState(false);
	const [showSetup, setShowSetup] = useState(Boolean(revealedUrl));
	const enabled = source.enabled === "on";

	const toggle = useMutation({
		mutationFn: (next: boolean) =>
			updateIngressSource({ data: { id: source.id, enabled: next } }),
		onSuccess: refresh,
		onError: (error) => toast.error(errorText(error)),
	});
	const test = useMutation({
		mutationFn: () => testIngressSource({ data: { id: source.id } }),
		onSuccess: async (result) => {
			if (result.ok) toast.success(result.message);
			else toast.error(result.message);
			await refresh();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const poll = useMutation({
		mutationFn: () => pollIngressSourceNow({ data: { id: source.id } }),
		onSuccess: async (result) => {
			if (result.ok) toast.success(result.message);
			else toast.error(result.message);
			await refresh();
			await client.invalidateQueries({ queryKey: ["ledger"] });
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const rotate = useMutation({
		mutationFn: () => rotateIngressPushToken({ data: { id: source.id } }),
		onSuccess: (result) => {
			onRevealed(result.webhookUrl);
			setShowSetup(true);
			toast.success("New webhook URL created — the old one no longer works");
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const remove = useMutation({
		mutationFn: () => deleteIngressSource({ data: { id: source.id } }),
		onSuccess: async () => {
			toast.success("Source deleted");
			await refresh();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const push = meta?.push ?? source.kind === "inbound_email";

	return (
		<section
			className={cn(
				"rounded border bg-card",
				source.status === "error" ? "border-red-500/40" : "border-border",
				!enabled && "opacity-75",
			)}
		>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
				<Switch
					checked={enabled}
					disabled={toggle.isPending}
					onChange={(next) => toggle.mutate(next)}
					label={enabled ? `Disable ${source.name}` : `Enable ${source.name}`}
				/>
				<Tag tone="primary">{meta?.label ?? source.kind}</Tag>
				<h2 className="min-w-0 truncate text-[13px] font-semibold">
					{source.name}
				</h2>
				<Tag tone={STATUS_TONE[source.status]}>{source.status}</Tag>
				<span className="font-mono text-[11px] text-muted-foreground">
					{push
						? source.lastRunAt
							? `last email ${rel(source.lastRunAt)}`
							: "no email received yet"
						: `every ${source.intervalMinutes}m · ${
								source.lastRunAt
									? `last run ${rel(source.lastRunAt)}`
									: "never run"
							}`}
				</span>
				<span className="ml-auto flex flex-wrap gap-1">
					<Button
						size="xs"
						disabled={test.isPending}
						onClick={() => test.mutate()}
					>
						<IconPlayerPlay /> {test.isPending ? "Testing…" : "Test"}
					</Button>
					{push ? (
						<>
							<Button
								size="xs"
								variant={showSetup ? "primary" : "secondary"}
								aria-expanded={showSetup}
								onClick={() => setShowSetup(!showSetup)}
							>
								<IconInbox /> Setup
							</Button>
							<Button
								size="xs"
								disabled={rotate.isPending}
								onClick={() => {
									if (
										!source.hasPushToken ||
										window.confirm(
											"Create a new webhook URL? The current URL stops working immediately.",
										)
									)
										rotate.mutate();
								}}
							>
								<IconKey /> Rotate token
							</Button>
						</>
					) : (
						<Button
							size="xs"
							disabled={poll.isPending || !enabled}
							title={
								enabled ? "Fetch new items now" : "Enable the source first"
							}
							onClick={() => poll.mutate()}
						>
							<IconRefresh /> {poll.isPending ? "Polling…" : "Poll now"}
						</Button>
					)}
					{meta &&
						(meta.configFields.length > 0 ||
							meta.secretFields.length > 0 ||
							!push) && (
							<Button
								size="xs"
								variant="ghost"
								aria-label={`Edit ${source.name}`}
								onClick={() => setEditing(!editing)}
							>
								<IconPencil />
							</Button>
						)}
					<Button
						size="xs"
						variant="ghost"
						aria-label={`Delete ${source.name}`}
						disabled={remove.isPending}
						onClick={() => {
							if (
								window.confirm(
									`Delete “${source.name}”? Already imported captures and orders are kept.`,
								)
							)
								remove.mutate();
						}}
					>
						<IconTrash />
					</Button>
				</span>
			</header>
			{source.lastError && (
				<div className="flex gap-2 border-t border-red-500/30 bg-red-500/5 px-3 py-1.5 text-[11px] text-red-700 dark:text-red-300">
					<IconAlertTriangle className="mt-px size-3.5 shrink-0" />
					<span className="break-words">{source.lastError}</span>
				</div>
			)}
			{editing && meta && (
				<div className="border-t border-border p-3">
					<SourceForm
						meta={meta}
						source={source}
						onDone={async () => {
							setEditing(false);
							await refresh();
						}}
					/>
				</div>
			)}
			{push && showSetup && (
				<div className="border-t border-border p-3">
					<InboundSetup url={revealedUrl} base={webhookBase} />
				</div>
			)}
		</section>
	);
}

function SourcesPage() {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: SOURCES_KEY,
		queryFn: () => listIngressSources(),
		refetchInterval: 30_000,
	});
	const [creating, setCreating] = useState<SourceKindMeta["kind"] | null>(null);
	/** Webhook URLs revealed in this page session (token shown once). */
	const [revealed, setRevealed] = useState<Record<string, string>>({});
	const kinds = query.data?.kinds ?? [];
	const kindByKey = new Map(kinds.map((k) => [k.kind, k] as const));
	const creatingMeta = creating ? kindByKey.get(creating) : undefined;
	const rows = query.data?.sources ?? [];
	const webhookBase = query.data?.webhookBase ?? "";

	const onCreated = async (created?: CreatedSource) => {
		setCreating(null);
		const url = created?.webhookUrl;
		if (created && url) {
			setRevealed((prev) => ({ ...prev, [created.source.id]: url }));
		}
		await client.invalidateQueries({ queryKey: SOURCES_KEY });
	};

	return (
		<div className="pb-10">
			<PageHeader
				title="Sources"
				description="Mailboxes, forwarding addresses and document/store APIs that feed captures automatically."
				actions={
					<div className="flex flex-wrap gap-1">
						{kinds.map((kind) => (
							<Button
								key={kind.kind}
								variant={creating === kind.kind ? "primary" : "secondary"}
								onClick={() => setCreating(kind.kind)}
							>
								<IconPlus /> {kind.label}
							</Button>
						))}
					</div>
				}
			/>
			<SettingsNav />
			<div className="mx-auto max-w-5xl space-y-3 p-4">
				{creatingMeta && (
					<Panel
						title={`New ${creatingMeta.label}`}
						className="border-primary/40"
					>
						<div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
							<SourceForm
								key={creatingMeta.kind}
								meta={creatingMeta}
								onDone={onCreated}
							/>
							<Callout
								tone="info"
								icon={<IconInbox />}
								title={creatingMeta.label}
							>
								<p>{creatingMeta.description}</p>
								{creatingMeta.push && (
									<p>
										After creating it you get a private webhook URL (shown once)
										and a ready-to-paste Cloudflare Email Worker.
									</p>
								)}
							</Callout>
						</div>
					</Panel>
				)}
				{query.isLoading ? (
					<p className="py-8 text-center text-xs text-muted-foreground">
						Loading sources…
					</p>
				) : query.isError ? (
					<Callout tone="danger" title="Could not load sources">
						{errorText(query.error)}
					</Callout>
				) : rows.length === 0 && !creating ? (
					<EmptyState
						icon={<IconInbox className="size-6" />}
						title="No sources yet"
					>
						Add a <strong>forwarding address</strong> to forward order
						confirmations to, or an <strong>IMAP mailbox</strong> to poll.
						Emails become captures; orders found in them are queued for
						enrichment.
					</EmptyState>
				) : (
					rows.map((source) => (
						<SourceCard
							key={source.id}
							source={source}
							meta={kindByKey.get(source.kind)}
							webhookBase={webhookBase}
							revealedUrl={revealed[source.id]}
							onRevealed={(url) =>
								setRevealed((prev) => ({ ...prev, [source.id]: url }))
							}
						/>
					))
				)}
				<p className="text-[11px] text-muted-foreground">
					Imported emails and documents appear under{" "}
					<Link to="/app/captures" className="text-primary underline">
						Captures
					</Link>{" "}
					with their parse status. Secrets are encrypted at rest and never shown
					again.
				</p>
			</div>
		</div>
	);
}
