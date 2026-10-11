import {
	IconAlertTriangle,
	IconArrowsExchange,
	IconPencil,
	IconPlayerPlay,
	IconPlugConnected,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	PageHeader,
	Panel,
	Tag,
} from "#/components/app/primitives";
import {
	ConnectionForm,
	type ConnectionRow,
	type ProviderId,
	type ProviderMeta,
} from "#/components/settings/connection-form";
import { MappingEditor } from "#/components/settings/mapping-editor";
import { Callout, errorText, SettingsNav } from "#/components/settings/ui";
import {
	ledgerKeys,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import {
	deleteConnection,
	listConnections,
	listConnectorProviders,
	testConnection,
} from "#/features/ledger/ledger.functions";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/app/settings/connections")({
	component: ConnectionsPage,
});

const STATUS_TONE = {
	ok: "success",
	error: "danger",
	untested: "neutral",
} as const;

const PROVIDER_GUIDES: Record<ProviderId, { title: string; body: ReactNode }> =
	{
		custom_http: {
			title: "Custom HTTP",
			body: (
				<p>
					Choose explicit operations and field mappings. Test uses a read-only
					GET. Your administrator must approve the endpoint and its network
					addresses. Expense writes require provider-supported idempotency.
				</p>
			),
		},
		invoice_ninja: {
			title: "Invoice Ninja",
			body: (
				<ul className="list-disc space-y-1 pl-4">
					<li>
						Create an API token in Invoice Ninja under{" "}
						<strong>
							Settings → Account Management → Integrations → API tokens
						</strong>
						.
					</li>
					<li>
						API URL: <code>https://invoicing.co</code> for hosted, or your
						self-hosted root (the API lives at <code>/api/v1</code>).
					</li>
					<li>
						<strong>Web app URL</strong> is optional and only used to build
						“open in Invoice Ninja” links (hosted:{" "}
						<code>https://app.invoicing.co</code>).
					</li>
					<li>
						Categories map to expense categories; invoices are uploaded as
						expense documents.
					</li>
				</ul>
			),
		},
	};

function ProviderGuide({ provider }: { provider: ProviderMeta }) {
	const guide = PROVIDER_GUIDES[provider.id];
	return (
		<Callout
			tone="info"
			icon={<IconPlugConnected />}
			title={`${guide.title} setup`}
		>
			<p>{provider.description}</p>
			{guide.body}
		</Callout>
	);
}

function ConnectionCard({
	connection,
	provider,
	editing,
	mapping,
	onEdit,
	onMap,
}: {
	connection: ConnectionRow;
	provider?: ProviderMeta;
	editing: boolean;
	mapping: boolean;
	onEdit: (open: boolean) => void;
	onMap: (open: boolean) => void;
}) {
	const { entityById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const test = useMutation({
		mutationFn: () => testConnection({ data: { id: connection.id } }),
		onSuccess: async (result) => {
			if (result.ok) toast.success(result.summary ?? "Connection OK");
			else toast.error(result.error ?? "Connection failed");
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const remove = useMutation({
		mutationFn: () => deleteConnection({ data: { id: connection.id } }),
		onSuccess: async () => {
			toast.success("Connection deleted");
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const catMap = connection.config.categoryAccountMap;
	const mappedCount =
		catMap && typeof catMap === "object" ? Object.keys(catMap).length : 0;
	const hasDefault = Boolean(connection.config.defaultExpenseAccountId);

	return (
		<section
			className={cn(
				"rounded border bg-card",
				connection.status === "error" ? "border-red-500/40" : "border-border",
				!connection.enabled && "opacity-75",
			)}
		>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
				<Tag tone="primary">{provider?.label ?? connection.provider}</Tag>
				<h2 className="min-w-0 truncate text-[13px] font-semibold">
					{connection.name}
				</h2>
				<EntityChip entity={entityById.get(connection.entityId)} />
				<Tag tone={STATUS_TONE[connection.status]}>{connection.status}</Tag>
				{!connection.enabled && <Tag tone="warning">disabled</Tag>}
				<span className="font-mono text-[11px] text-muted-foreground">
					{connection.lastCheckedAt
						? `checked ${formatRelative(connection.lastCheckedAt)}`
						: "never checked"}
				</span>
				<span className="ml-auto flex flex-wrap gap-1">
					<Button
						size="xs"
						disabled={test.isPending}
						onClick={() => test.mutate()}
					>
						<IconPlayerPlay /> {test.isPending ? "Testing…" : "Test"}
					</Button>
					<Button
						size="xs"
						variant={mapping ? "primary" : "secondary"}
						aria-expanded={mapping}
						onClick={() => onMap(!mapping)}
					>
						<IconArrowsExchange /> Map accounts
					</Button>
					<Button
						size="xs"
						variant="ghost"
						aria-label={`Edit ${connection.name}`}
						onClick={() => onEdit(!editing)}
					>
						<IconPencil />
					</Button>
					<Button
						size="xs"
						variant="ghost"
						aria-label={`Delete ${connection.name}`}
						disabled={remove.isPending}
						onClick={() => {
							if (
								window.confirm(
									`Delete “${connection.name}”? Export history for it is removed too.`,
								)
							)
								remove.mutate();
						}}
					>
						<IconTrash />
					</Button>
				</span>
			</header>
			{connection.status === "error" && connection.lastError && (
				<div className="flex gap-2 border-t border-red-500/30 bg-red-500/5 px-3 py-1.5 text-[11px] text-red-700 dark:text-red-300">
					<IconAlertTriangle className="mt-px size-3.5 shrink-0" />
					<span className="break-words">{connection.lastError}</span>
				</div>
			)}
			{!mapping && !editing && (
				<div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
					{mappedCount} categor{mappedCount === 1 ? "y" : "ies"} mapped ·{" "}
					{hasDefault ? (
						"default expense account set"
					) : (
						<span className="text-amber-600 dark:text-amber-400">
							no default expense account
						</span>
					)}
					{connection.status === "untested" && " · run Test before exporting"}
				</div>
			)}
			{editing && provider && (
				<div className="space-y-3 border-t border-border p-3">
					<ProviderGuide provider={provider} />
					<ConnectionForm
						provider={provider}
						connection={connection}
						onDone={() => onEdit(false)}
					/>
				</div>
			)}
			{mapping && (
				<div className="border-t border-border px-3 pt-3">
					{connection.status === "error" && (
						<Callout tone="warning" className="mb-2">
							Last test failed — loading options will likely fail until
							credentials are fixed.
						</Callout>
					)}
					<MappingEditor key={connection.updatedAt} connection={connection} />
				</div>
			)}
		</section>
	);
}

function ConnectionsPage() {
	const { activeEntities } = useBootstrap();
	const providers = useQuery({
		queryKey: ["connector-providers"],
		queryFn: () => listConnectorProviders(),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const connections = useQuery({
		queryKey: ledgerKeys.connections,
		queryFn: () => listConnections(),
	});
	const [creating, setCreating] = useState<ProviderId | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [mapping, setMapping] = useState<string | null>(null);
	const providerById = new Map(
		(providers.data ?? []).map((p) => [p.id, p] as const),
	);
	const creatingProvider = creating ? providerById.get(creating) : undefined;
	const rows = connections.data ?? [];

	return (
		<div className="pb-10">
			<PageHeader
				title="Connections"
				description="Push filed expenses (with invoices) into each entity's books."
				actions={
					<div className="flex flex-wrap gap-1">
						{(providers.data ?? []).map((provider) => (
							<Button
								key={provider.id}
								variant={creating === provider.id ? "primary" : "secondary"}
								disabled={activeEntities.length === 0}
								onClick={() => setCreating(provider.id)}
							>
								<IconPlus /> {provider.label}
							</Button>
						))}
					</div>
				}
			/>
			<SettingsNav />
			<div className="mx-auto max-w-5xl space-y-3 p-4">
				{activeEntities.length === 0 && (
					<Callout tone="warning" title="Create an entity first">
						Each connection writes to one entity's books.{" "}
						<Link to="/app/settings" className="text-primary underline">
							Set up entities
						</Link>
						.
					</Callout>
				)}
				{creatingProvider && (
					<Panel
						title={`New ${creatingProvider.label} connection`}
						className="border-primary/40"
					>
						<div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
							<ConnectionForm
								provider={creatingProvider}
								onDone={(id) => {
									setCreating(null);
									if (id) setMapping(null);
								}}
							/>
							<ProviderGuide provider={creatingProvider} />
						</div>
					</Panel>
				)}
				{connections.isLoading ? (
					<p className="py-8 text-center text-xs text-muted-foreground">
						Loading connections…
					</p>
				) : connections.isError ? (
					<Callout tone="danger" title="Could not load connections">
						{errorText(connections.error)}
					</Callout>
				) : rows.length === 0 && !creating ? (
					<EmptyState
						icon={<IconPlugConnected className="size-6" />}
						title="No accounting connections"
					>
						Connect custom HTTP or Invoice Ninja per entity. Filed orders can
						then be exported as expenses with their invoices attached;
						categories and cards map to remote accounts.
					</EmptyState>
				) : (
					rows.map((connection) => (
						<ConnectionCard
							key={connection.id}
							connection={connection}
							provider={providerById.get(connection.provider)}
							editing={editing === connection.id}
							mapping={mapping === connection.id}
							onEdit={(open) => {
								setEditing(open ? connection.id : null);
								if (open) setMapping(null);
							}}
							onMap={(open) => {
								setMapping(open ? connection.id : null);
								if (open) setEditing(null);
							}}
						/>
					))
				)}
				<p className="text-[11px] text-muted-foreground">
					Workflow: create → <strong>Test</strong> →{" "}
					<strong>Map accounts</strong> (load remote expense/payment accounts,
					map categories and cards, set defaults) → export from an order or the
					Orders table.
				</p>
			</div>
		</div>
	);
}
