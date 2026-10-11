import {
	IconKey,
	IconPlus,
	IconPuzzle,
	IconRobot,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
	Button,
	Field,
	Input,
	PageHeader,
	Panel,
	Select,
} from "#/components/app/primitives";
import {
	ApiKeyList,
	apiKeysQueryKey,
} from "#/components/settings/api-key-list";
import { errorText, SecretBox, SettingsNav } from "#/components/settings/ui";
import {
	createApiKey,
	getApiKeyManager,
} from "#/integrations/api-platform/api-keys.functions";
import {
	AGENT_PERMISSION_PRESETS,
	type AgentPreset,
	type ApiPermissions,
	EXTENSION_PERMISSIONS,
	toApiPermissions,
} from "#/integrations/api-platform/permissions";

export const Route = createFileRoute("/app/api-keys")({
	beforeLoad: async () => {
		if (!(await getApiKeyManager())) throw redirect({ to: "/" });
	},
	component: ApiKeysPage,
});

const extensionPreset = (): ApiPermissions =>
	toApiPermissions(EXTENSION_PERMISSIONS);
const agentPreset = (preset: AgentPreset): ApiPermissions =>
	toApiPermissions(AGENT_PERMISSION_PRESETS[preset].permissions);
const AGENT_PRESETS = Object.entries(AGENT_PERMISSION_PRESETS) as Array<
	[AgentPreset, (typeof AGENT_PERMISSION_PRESETS)[AgentPreset]]
>;

const GRANTS: Array<{
	resource: keyof ApiPermissions;
	action: string;
	label: string;
	hint: string;
}> = [
	{
		resource: "captures",
		action: "write",
		label: "captures:write",
		hint: "Upload captures and invoice documents (extension)",
	},
	{
		resource: "orders",
		action: "read",
		label: "orders:read",
		hint: "Look up which store orders are tracked (extension)",
	},
	{
		resource: "ledger",
		action: "read",
		label: "ledger:read",
		hint: "Agent API / MCP: read orders, claims, rules, captures, insights",
	},
	{
		resource: "ledger",
		action: "write",
		label: "ledger:write",
		hint: "Agent API / MCP: create and triage orders, reimbursements, claims, exports",
	},
	{
		resource: "admin",
		action: "write",
		label: "admin:write",
		hint: "Agent API / MCP: manage entities, categories, cards, rules, connections",
	},
];

function ApiKeysPage() {
	const client = useQueryClient();
	const [creating, setCreating] = useState(false);
	const [agentMode, setAgentMode] = useState<AgentPreset | null>(null);
	const [name, setName] = useState("");
	const [permissions, setPermissions] =
		useState<ApiPermissions>(extensionPreset);
	const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const [secretIsAgent, setSecretIsAgent] = useState(false);

	const create = useMutation({
		mutationFn: () =>
			createApiKey({
				data: { name: name.trim(), permissions, expiresInDays },
			}),
		onSuccess: async (result) => {
			setSecret(result.secret);
			setSecretIsAgent(permissions.ledger.length > 0);
			setCreating(false);
			setAgentMode(null);
			setName("");
			setPermissions(extensionPreset());
			setExpiresInDays(null);
			await client.invalidateQueries({ queryKey: apiKeysQueryKey });
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const has = (resource: keyof ApiPermissions, action: string) =>
		(permissions[resource] as string[]).includes(action);
	const toggle = (resource: keyof ApiPermissions, action: string) =>
		setPermissions((current) => {
			const list = current[resource] as string[];
			return {
				...current,
				[resource]: list.includes(action)
					? list.filter((a) => a !== action)
					: [...list, action],
			} as ApiPermissions;
		});
	const grantCount = Object.values(permissions).reduce(
		(sum, actions) => sum + actions.length,
		0,
	);
	const startAgentKey = () => {
		setAgentMode("readWrite");
		setPermissions(agentPreset("readWrite"));
		setName(`Agent (${new Date().toISOString().slice(0, 10)})`);
		setCreating(true);
	};
	const startCustomKey = () => {
		setAgentMode(null);
		setPermissions(extensionPreset());
		setCreating(true);
	};

	return (
		<div className="pb-10">
			<PageHeader
				title="API keys"
				description="User-owned credentials for the browser extension and the versioned machine API."
				actions={
					<div className="flex gap-2">
						<Button onClick={startAgentKey}>
							<IconRobot /> Create agent key
						</Button>
						<Button variant="primary" onClick={startCustomKey}>
							<IconPlus /> New key
						</Button>
					</div>
				}
			/>
			<SettingsNav />
			<div className="mx-auto max-w-4xl space-y-4 p-4">
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<IconPuzzle className="size-3.5" />
					Setting up the browser extension? The{" "}
					<Link
						to="/app/settings/extension"
						className="text-primary underline-offset-2 hover:underline"
					>
						extension guide
					</Link>{" "}
					creates a correctly scoped key in one click.
				</p>
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<IconRobot className="size-3.5" />
					Agent keys work with the REST API (
					<a
						href="/docs/api"
						className="text-primary underline-offset-2 hover:underline"
					>
						/docs/api
					</a>
					) and the MCP server at <code className="font-mono">/api/mcp</code>{" "}
					(send{" "}
					<code className="font-mono">Authorization: Bearer &lt;key&gt;</code>
					).
				</p>

				{secret && (
					<Panel
						title="Copy this key now"
						className="border-primary/40"
						action={
							<Button
								size="xs"
								variant="ghost"
								aria-label="Dismiss API key"
								onClick={() => setSecret(null)}
							>
								<IconX />
							</Button>
						}
					>
						<div className="space-y-1.5">
							<p className="text-xs text-muted-foreground">
								It cannot be recovered after this message is dismissed.
							</p>
							<SecretBox label="New API key" value={secret} />
							{secretIsAgent && (
								<SecretBox
									label="Claude Code (MCP)"
									value={`claude mcp add --transport http ledgercatch ${typeof window === "undefined" ? "" : window.location.origin}/api/mcp --header "Authorization: Bearer ${secret}"`}
								/>
							)}
						</div>
					</Panel>
				)}

				{creating && (
					<Panel title={agentMode ? "New agent key" : "New API key"}>
						<form
							className="space-y-3"
							onSubmit={(e) => {
								e.preventDefault();
								create.mutate();
							}}
						>
							<div className="grid gap-2 sm:grid-cols-2">
								<Field label="Name">
									<Input
										required
										autoFocus
										maxLength={32}
										value={name}
										className="font-sans"
										onChange={(e) => setName(e.target.value)}
									/>
								</Field>
								<Field label="Expiration">
									<Select
										value={expiresInDays ?? ""}
										onChange={(e) =>
											setExpiresInDays(
												e.target.value ? Number(e.target.value) : null,
											)
										}
									>
										<option value="">No expiration</option>
										<option value="30">30 days</option>
										<option value="90">90 days</option>
										<option value="365">1 year</option>
									</Select>
								</Field>
							</div>
							{agentMode && (
								<fieldset className="space-y-1">
									<legend className="label-caps mb-1">Agent access</legend>
									{AGENT_PRESETS.map(([key, preset]) => (
										<label
											key={key}
											className="flex items-center gap-2 text-xs"
										>
											<input
												type="radio"
												name="agent-preset"
												checked={agentMode === key}
												onChange={() => {
													setAgentMode(key);
													setPermissions(agentPreset(key));
												}}
											/>
											<span className="w-28 font-medium">{preset.label}</span>
											<span className="text-[11px] text-muted-foreground">
												{preset.description}
											</span>
										</label>
									))}
								</fieldset>
							)}
							<fieldset className="space-y-1">
								<legend className="label-caps mb-1">Permissions</legend>
								{GRANTS.map((grant) => (
									<label
										key={grant.label}
										className="flex items-center gap-2 text-xs"
									>
										<input
											type="checkbox"
											checked={has(grant.resource, grant.action)}
											onChange={() => toggle(grant.resource, grant.action)}
										/>
										<code className="w-28 font-mono">{grant.label}</code>
										<span className="text-[11px] text-muted-foreground">
											{grant.hint}
										</span>
									</label>
								))}
							</fieldset>
							<div className="flex justify-end gap-2">
								<Button
									variant="ghost"
									onClick={() => {
										setCreating(false);
										setAgentMode(null);
									}}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									variant="primary"
									disabled={
										create.isPending || grantCount === 0 || !name.trim()
									}
								>
									<IconKey /> Create key
								</Button>
							</div>
						</form>
					</Panel>
				)}

				<Panel title="Keys">
					<ApiKeyList emptyText="No API keys yet. Create one when a machine or the extension needs access." />
				</Panel>
			</div>
		</div>
	);
}
