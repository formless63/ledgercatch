/**
 * Invoice Ninja reimbursement invoices: per connection, the trusted draft
 * policy, auto-draft switch, inbound webhook secret and entity → client map.
 */
import { IconFileInvoice, IconKey, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Field,
	Input,
	Panel,
	Tag,
} from "#/components/app/primitives";
import { Callout, errorText, Switch } from "#/components/settings/ui";
import {
	getInvoiceNinjaSetup,
	mapInvoiceNinjaClient,
	revealInvoiceNinjaWebhookSecret,
	rotateInvoiceNinjaWebhookSecret,
	saveInvoiceNinjaClaimSettings,
} from "#/features/automation/automation.functions";
import { useBootstrap } from "#/features/ledger/hooks";
import { automationKeys } from "./notification-settings";

type Setup = Awaited<ReturnType<typeof getInvoiceNinjaSetup>>;
type Connection = Setup["connections"][number];

export function InvoiceNinjaClaimsPanel() {
	const query = useQuery({
		queryKey: automationKeys.invoiceNinja,
		queryFn: () => getInvoiceNinjaSetup(),
	});
	const connections = query.data?.connections ?? [];
	const drafts = query.data?.drafts ?? [];
	return (
		<Panel
			title="Reimbursement invoices (Invoice Ninja)"
			bodyClassName="flex flex-col gap-3"
		>
			<p className="text-[11px] text-muted-foreground">
				When a claim is submitted, create an <strong>unsent draft</strong>{" "}
				invoice for the owing entity's Invoice Ninja client. When Invoice Ninja
				reports it paid, the claim is marked paid. Review and send drafts in
				Invoice Ninja yourself.
			</p>
			{connections.length === 0 ? (
				<EmptyState
					icon={<IconFileInvoice />}
					title="No Invoice Ninja connection"
				>
					Add one under{" "}
					<Link to="/app/settings/connections" className="underline">
						Connections
					</Link>{" "}
					first.
				</EmptyState>
			) : (
				connections.map((connection) => (
					<ConnectionCard key={connection.id} connection={connection} />
				))
			)}
			{drafts.length > 0 && (
				<div className="flex flex-col gap-1">
					<div className="label-caps">Recent drafts</div>
					<ul className="divide-y divide-border rounded-sm border border-border text-xs">
						{drafts.map((draft) => (
							<li
								key={draft.claimId}
								className="flex items-center gap-2 px-2.5 py-1.5"
							>
								<span className="font-mono">{draft.claimId.slice(0, 8)}</span>
								<Tag
									tone={
										draft.operationStatus === "succeeded"
											? "success"
											: draft.operationStatus === "failed" ||
													draft.operationStatus === "reconciliation_required"
												? "danger"
												: "neutral"
									}
								>
									{draft.operationStatus ?? "unknown"}
								</Tag>
								{draft.invoiceNumber && <span>#{draft.invoiceNumber}</span>}
								{draft.invoiceStatus && <Tag>{draft.invoiceStatus}</Tag>}
								{draft.operationError && (
									<span className="text-red-600 dark:text-red-400">
										{draft.operationError}
									</span>
								)}
								<span className="ml-auto text-muted-foreground">
									{formatRelative(draft.createdAt)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</Panel>
	);
}

function ConnectionCard({ connection }: { connection: Connection }) {
	const client = useQueryClient();
	const { activeEntities } = useBootstrap();
	const invalidate = () =>
		client.invalidateQueries({ queryKey: automationKeys.invoiceNinja });
	const [policy, setPolicy] = useState({
		currencyId: connection.policy?.currencyId ?? "",
		currency: connection.policy?.currency ?? "USD",
		configurationIdentity: connection.policy?.configurationIdentity ?? "",
		verified: !!connection.policy,
	});
	const [autoDraft, setAutoDraft] = useState(connection.autoDraft);
	const [secret, setSecret] = useState<string | null>(null);
	const [clients, setClients] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			connection.mappings.map((m) => [m.entityId, m.remoteClientId]),
		),
	);
	const save = useMutation({
		mutationFn: () =>
			saveInvoiceNinjaClaimSettings({
				data: {
					connectionId: connection.id,
					autoDraft,
					policy:
						policy.verified && policy.currencyId && policy.configurationIdentity
							? { ...policy, verified: true as const }
							: null,
				},
			}),
		onSuccess: () => {
			toast.success("Saved");
			void invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const rotate = useMutation({
		mutationFn: () =>
			rotateInvoiceNinjaWebhookSecret({
				data: { connectionId: connection.id },
			}),
		onSuccess: (result) => {
			setSecret(result.secret);
			void invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const reveal = useMutation({
		mutationFn: () =>
			revealInvoiceNinjaWebhookSecret({
				data: { connectionId: connection.id },
			}),
		onSuccess: (result) => setSecret(result.secret),
		onError: (error) => toast.error(errorText(error)),
	});
	const map = useMutation({
		mutationFn: (input: { entityId: string; remoteClientId: string | null }) =>
			mapInvoiceNinjaClient({
				data: { connectionId: connection.id, ...input },
			}),
		onSuccess: () => {
			toast.success("Client mapping saved");
			void invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const mapped = new Map(
		connection.mappings.map((m) => [m.entityId, m.remoteClientId]),
	);
	return (
		<div className="flex flex-col gap-3 rounded-sm border border-border p-2.5">
			<div className="flex items-center gap-2 text-xs font-medium">
				<IconFileInvoice className="size-3.5" />
				{connection.name}
				{!connection.enabled && <Tag>disabled</Tag>}
				{connection.policy ? (
					<Tag tone="success">policy verified</Tag>
				) : (
					<Tag tone="warning">no draft policy</Tag>
				)}
			</div>
			<div className="grid gap-2 sm:grid-cols-3">
				<Field
					label="Invoice Ninja currency id"
					hint="Company currency_id (e.g. 1 = USD)"
				>
					<Input
						value={policy.currencyId}
						onChange={(e) =>
							setPolicy({
								...policy,
								currencyId: e.target.value,
								verified: false,
							})
						}
					/>
				</Field>
				<Field label="Currency (ISO)">
					<Input
						value={policy.currency}
						maxLength={3}
						onChange={(e) =>
							setPolicy({
								...policy,
								currency: e.target.value.toUpperCase(),
								verified: false,
							})
						}
					/>
				</Field>
				<Field
					label="Configuration identity"
					hint="Company key/settings you verified"
				>
					<Input
						value={policy.configurationIdentity}
						onChange={(e) =>
							setPolicy({
								...policy,
								configurationIdentity: e.target.value,
								verified: false,
							})
						}
					/>
				</Field>
			</div>
			<label className="flex items-start gap-2 text-[11px]">
				<input
					type="checkbox"
					checked={policy.verified}
					onChange={(e) => setPolicy({ ...policy, verified: e.target.checked })}
				/>
				<span>
					I verified this Invoice Ninja company (5.13.x): new invoices stay
					unsent (no auto-email / auto-bill), no default taxes or discounts
					apply, and amounts are accepted as numeric strings. See
					docs/AUTOMATION.md.
				</span>
			</label>
			<div className="flex items-center gap-2 text-xs">
				<Switch
					checked={autoDraft}
					onChange={setAutoDraft}
					label="Auto-draft on submitted claims"
				/>
				Create a draft automatically when a claim is submitted
				<Button
					className="ml-auto"
					size="sm"
					variant="primary"
					onClick={() => save.mutate()}
					disabled={save.isPending}
				>
					Save
				</Button>
			</div>
			<div className="flex flex-col gap-1">
				<div className="label-caps">Paid status webhook</div>
				<p className="text-[11px] text-muted-foreground">
					In Invoice Ninja → Settings → Webhooks, add event “Update Invoice”
					with URL{" "}
					<code className="break-all font-mono">{connection.webhookUrl}</code>{" "}
					and header <code>X-Invoice-Ninja-Webhook-Secret</code> = the secret
					below.
				</p>
				<div className="flex gap-1">
					<Button
						size="xs"
						onClick={() => rotate.mutate()}
						disabled={rotate.isPending}
					>
						<IconRefresh />{" "}
						{connection.hasWebhookSecret ? "Rotate secret" : "Generate secret"}
					</Button>
					{connection.hasWebhookSecret && (
						<Button size="xs" variant="ghost" onClick={() => reveal.mutate()}>
							<IconKey /> Show
						</Button>
					)}
				</div>
				{secret && (
					<Callout tone="warning" icon={<IconKey />}>
						<code className="break-all font-mono">{secret}</code>
					</Callout>
				)}
			</div>
			<div className="flex flex-col gap-1">
				<div className="label-caps">Owing entity → Invoice Ninja client</div>
				{activeEntities.map((entity) => (
					<div key={entity.id} className="flex items-center gap-2">
						<EntityChip entity={entity} className="w-40" />
						<Input
							className="max-w-56"
							placeholder="client hashed id"
							value={clients[entity.id] ?? ""}
							onChange={(e) =>
								setClients({ ...clients, [entity.id]: e.target.value })
							}
						/>
						<Button
							size="xs"
							disabled={
								map.isPending ||
								(clients[entity.id] ?? "") === (mapped.get(entity.id) ?? "")
							}
							onClick={() =>
								map.mutate({
									entityId: entity.id,
									remoteClientId: clients[entity.id]?.trim() || null,
								})
							}
						>
							{clients[entity.id]?.trim() ? "Map" : "Unmap"}
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}
