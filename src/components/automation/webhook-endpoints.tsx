/** Outbound webhook endpoints: CRUD, signing secret, test delivery. */
import {
	IconKey,
	IconPencil,
	IconPlayerPlay,
	IconPlus,
	IconTrash,
	IconWebhook,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	Field,
	Input,
	Panel,
	Tag,
} from "#/components/app/primitives";
import { Callout, errorText, Switch } from "#/components/settings/ui";
import {
	deleteWebhookEndpoint,
	listWebhookEndpoints,
	revealWebhookSecret,
	saveWebhookEndpoint,
	testWebhookEndpoint,
} from "#/features/automation/automation.functions";
import {
	WEBHOOK_EVENT_TYPES,
	type WebhookEventType,
} from "#/features/automation/inputs";
import { automationKeys } from "./notification-settings";

type Endpoint = Awaited<
	ReturnType<typeof listWebhookEndpoints>
>["endpoints"][number];
type Draft = {
	id?: string;
	name: string;
	url: string;
	events: WebhookEventType[];
	enabled: boolean;
	rotateSecret?: boolean;
};

export function WebhookEndpointsPanel() {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: automationKeys.endpoints,
		queryFn: () => listWebhookEndpoints(),
	});
	const [draft, setDraft] = useState<Draft | null>(null);
	const [secret, setSecret] = useState<{ name: string; value: string } | null>(
		null,
	);
	const invalidate = () =>
		client.invalidateQueries({ queryKey: automationKeys.endpoints });
	const save = useMutation({
		mutationFn: (value: Draft) => saveWebhookEndpoint({ data: value }),
		onSuccess: (result) => {
			setDraft(null);
			if (result.secret)
				setSecret({ name: result.endpoint.name, value: result.secret });
			toast.success("Endpoint saved");
			void invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteWebhookEndpoint({ data: { id } }),
		onSuccess: () => void invalidate(),
		onError: (error) => toast.error(errorText(error)),
	});
	const test = useMutation({
		mutationFn: (id: string) => testWebhookEndpoint({ data: { id } }),
		onSuccess: (result) => {
			(result.ok ? toast.success : toast.error)(result.message);
			void invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const reveal = useMutation({
		mutationFn: (endpoint: Endpoint) =>
			revealWebhookSecret({ data: { id: endpoint.id } }).then((r) => ({
				name: endpoint.name,
				value: r.secret,
			})),
		onSuccess: setSecret,
		onError: (error) => toast.error(errorText(error)),
	});

	const endpoints = query.data?.endpoints ?? [];
	return (
		<Panel
			title="Outbound webhooks"
			action={
				<Button
					size="xs"
					onClick={() =>
						setDraft({ name: "", url: "", events: [], enabled: true })
					}
				>
					<IconPlus /> Endpoint
				</Button>
			}
			bodyClassName="flex flex-col gap-3"
		>
			<p className="text-[11px] text-muted-foreground">
				Signed Standard Webhooks (<code>webhook-id</code>,{" "}
				<code>webhook-timestamp</code>, <code>webhook-signature</code>) with
				retries. Events: {WEBHOOK_EVENT_TYPES.join(", ")}.
				{query.data &&
					!query.data.allowPrivate &&
					" Endpoints must be public HTTPS."}
			</p>
			{secret && (
				<Callout
					tone="warning"
					icon={<IconKey />}
					title={`Signing secret — ${secret.name}`}
				>
					<code className="break-all font-mono">{secret.value}</code>
					<div className="mt-1">
						<Button size="xs" variant="ghost" onClick={() => setSecret(null)}>
							Hide
						</Button>
					</div>
				</Callout>
			)}
			{draft && (
				<EndpointForm
					draft={draft}
					onChange={setDraft}
					onCancel={() => setDraft(null)}
					onSave={() => save.mutate(draft)}
					saving={save.isPending}
				/>
			)}
			{endpoints.length === 0 && !draft ? (
				<EmptyState icon={<IconWebhook />} title="No endpoints">
					Send order, claim, export and capture events to n8n, Home Assistant or
					any HTTPS receiver.
				</EmptyState>
			) : (
				<ul className="divide-y divide-border rounded-sm border border-border">
					{endpoints.map((endpoint) => (
						<li
							key={endpoint.id}
							className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-xs"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5 font-medium">
									{endpoint.name}
									{!endpoint.enabled && <Tag>off</Tag>}
									{endpoint.lastOutcome && (
										<Tag
											tone={
												endpoint.lastOutcome === "success"
													? "success"
													: "danger"
											}
											title={endpoint.lastError ?? undefined}
										>
											{endpoint.lastOutcome}
										</Tag>
									)}
								</div>
								<div className="truncate font-mono text-[11px] text-muted-foreground">
									{endpoint.url}
								</div>
								<div className="text-[11px] text-muted-foreground">
									{endpoint.events.length
										? endpoint.events.join(", ")
										: "All events"}
									{endpoint.lastDeliveryAt &&
										` · last ${formatRelative(endpoint.lastDeliveryAt)}`}
									{endpoint.lastError && ` · ${endpoint.lastError}`}
								</div>
							</div>
							<Button
								size="xs"
								onClick={() => test.mutate(endpoint.id)}
								disabled={test.isPending}
							>
								<IconPlayerPlay /> Test
							</Button>
							<Button
								size="xs"
								variant="ghost"
								onClick={() => reveal.mutate(endpoint)}
								title="Show signing secret"
							>
								<IconKey />
							</Button>
							<Button
								size="xs"
								variant="ghost"
								title="Edit"
								onClick={() =>
									setDraft({
										id: endpoint.id,
										name: endpoint.name,
										url: endpoint.url,
										events: endpoint.events as WebhookEventType[],
										enabled: endpoint.enabled,
									})
								}
							>
								<IconPencil />
							</Button>
							<Button
								size="xs"
								variant="ghost"
								title="Delete"
								onClick={() => {
									if (confirm(`Delete endpoint “${endpoint.name}”?`))
										remove.mutate(endpoint.id);
								}}
							>
								<IconTrash />
							</Button>
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}

function EndpointForm({
	draft,
	onChange,
	onCancel,
	onSave,
	saving,
}: {
	draft: Draft;
	onChange: (draft: Draft) => void;
	onCancel: () => void;
	onSave: () => void;
	saving: boolean;
}) {
	const toggle = (type: WebhookEventType) =>
		onChange({
			...draft,
			events: draft.events.includes(type)
				? draft.events.filter((t) => t !== type)
				: [...draft.events, type],
		});
	return (
		<div className="flex flex-col gap-2 rounded-sm border border-border bg-muted/30 p-2.5">
			<div className="grid gap-2 sm:grid-cols-2">
				<Field label="Name">
					<Input
						value={draft.name}
						onChange={(e) => onChange({ ...draft, name: e.target.value })}
					/>
				</Field>
				<Field label="URL">
					<Input
						value={draft.url}
						placeholder="https://n8n.example.com/webhook/…"
						onChange={(e) => onChange({ ...draft, url: e.target.value })}
					/>
				</Field>
			</div>
			<div className="label-caps">Events (none selected = all)</div>
			<div className="flex flex-wrap gap-x-3 gap-y-1">
				{WEBHOOK_EVENT_TYPES.map((type) => (
					<label
						key={type}
						className="flex items-center gap-1 font-mono text-[11px]"
					>
						<input
							type="checkbox"
							checked={draft.events.includes(type)}
							onChange={() => toggle(type)}
						/>
						{type}
					</label>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-3 text-xs">
				<span className="flex items-center gap-1.5">
					<Switch
						checked={draft.enabled}
						onChange={(enabled) => onChange({ ...draft, enabled })}
						label="Enabled"
					/>
					Enabled
				</span>
				{draft.id && (
					<label className="flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={!!draft.rotateSecret}
							onChange={(e) =>
								onChange({ ...draft, rotateSecret: e.target.checked })
							}
						/>
						Rotate signing secret
					</label>
				)}
				<div className="ml-auto flex gap-1">
					<Button size="sm" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="primary"
						onClick={onSave}
						disabled={saving || !draft.name.trim() || !draft.url.trim()}
					>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}
