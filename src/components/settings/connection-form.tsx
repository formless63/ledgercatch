import { IconLock, IconRefresh } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	Button,
	EntityChip,
	Field,
	Input,
	Select,
	Tag,
} from "#/components/app/primitives";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import type {
	listConnections,
	listConnectorProviders,
} from "#/features/ledger/ledger.functions";
import { saveConnection } from "#/features/ledger/ledger.functions";
import { HttpDefinitionEditor } from "./http-definition-editor";
import { errorText } from "./ui";

export type ProviderMeta = Awaited<
	ReturnType<typeof listConnectorProviders>
>[number];
export type ConnectionRow = Awaited<ReturnType<typeof listConnections>>[number];
export type ProviderId = ProviderMeta["id"];
type FieldMeta = ProviderMeta["configFields"][number];

export const MAPPING_KEYS = [
	"categoryAccountMap",
	"paymentAccountMap",
	"defaultExpenseAccountId",
	"defaultPaymentAccountId",
] as const;

/** Drop empty strings so optional provider fields validate. */
export function cleanConfig(config: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config))
		if (value !== "" && value !== undefined && value !== null) out[key] = value;
	return out;
}

function FieldInput({
	field,
	value,
	onChange,
	secret,
}: {
	field: FieldMeta;
	value: string;
	onChange: (value: string) => void;
	secret?: boolean;
}) {
	if (field.type === "json")
		return <HttpDefinitionEditor value={value} onChange={onChange} />;
	const label = (
		<>
			{field.label}
			{field.required && <span className="text-red-500"> *</span>}
		</>
	);
	if (field.type === "select")
		return (
			<Field label={label} hint={field.help}>
				<Select
					value={value}
					required={field.required}
					onChange={(e) => onChange(e.target.value)}
				>
					<option value="">—</option>
					{field.options?.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</Select>
			</Field>
		);
	return (
		<Field label={label} hint={field.help}>
			<Input
				type={
					secret || field.type === "password"
						? "password"
						: field.type === "url"
							? "url"
							: "text"
				}
				autoComplete={secret ? "new-password" : "off"}
				required={field.required}
				placeholder={field.placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</Field>
	);
}

export function ConnectionForm({
	provider,
	connection,
	onDone,
}: {
	provider: ProviderMeta;
	connection?: ConnectionRow;
	onDone: (id?: string) => void;
}) {
	const { activeEntities } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [name, setName] = useState(connection?.name ?? provider.label);
	const [entityId, setEntityId] = useState(
		connection?.entityId ??
			activeEntities.find((e) => e.kind === "business")?.id ??
			activeEntities[0]?.id ??
			"",
	);
	const [enabled, setEnabled] = useState(connection?.enabled ?? true);
	const [config, setConfig] = useState<Record<string, string>>(() => {
		const initial: Record<string, string> = {};
		for (const field of provider.configFields) {
			const value = connection?.config[field.key];
			initial[field.key] = typeof value === "string" ? value : "";
		}
		return initial;
	});
	const [replaceSecret, setReplaceSecret] = useState(!connection?.hasSecret);
	const [secret, setSecret] = useState<Record<string, string>>({});

	const save = useMutation({
		mutationFn: () => {
			const base: Record<string, unknown> = {};
			if (connection)
				for (const key of MAPPING_KEYS)
					if (connection.config[key] !== undefined)
						base[key] = connection.config[key];
			return saveConnection({
				data: {
					id: connection?.id,
					provider: provider.id,
					name: name.trim(),
					entityId,
					enabled,
					config: cleanConfig({ ...base, ...config }),
					secret: replaceSecret ? cleanConfig(secret) : undefined,
				},
			});
		},
		onSuccess: async (result) => {
			toast.success(
				connection ? "Connection saved" : "Connection created — test it next",
			);
			await invalidate();
			onDone(result.id);
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const entity = activeEntities.find((e) => e.id === entityId);
	const missingSecret =
		replaceSecret &&
		provider.secretFields.some((f) => f.required && !secret[f.key]?.trim());

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				save.mutate();
			}}
		>
			<div className="grid gap-2 sm:grid-cols-2">
				<Field label="Name">
					<Input
						required
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="font-sans"
					/>
				</Field>
				<Field
					label="Books of entity"
					hint="Only this entity's allocations are exported here."
				>
					<div className="flex items-center gap-2">
						<Select
							required
							value={entityId}
							onChange={(e) => setEntityId(e.target.value)}
						>
							{activeEntities.length === 0 && (
								<option value="">Create an entity first</option>
							)}
							{activeEntities.map((e) => (
								<option key={e.id} value={e.id}>
									{e.name}
								</option>
							))}
						</Select>
						<EntityChip short entity={entity} />
					</div>
				</Field>
				{provider.configFields.map((field) => (
					<FieldInput
						key={field.key}
						field={field}
						value={config[field.key] ?? ""}
						onChange={(value) =>
							setConfig((current) => ({ ...current, [field.key]: value }))
						}
					/>
				))}
			</div>
			<fieldset className="space-y-2 rounded-sm border border-border p-2">
				<legend className="label-caps flex items-center gap-1 px-1">
					<IconLock className="size-3" /> Credentials (write-only)
				</legend>
				{!replaceSecret ? (
					<div className="flex flex-wrap items-center gap-2 text-xs">
						{provider.secretFields.map((field) => (
							<span key={field.key} className="flex items-center gap-1.5">
								{field.label}
								<Tag tone="success">stored</Tag>
							</span>
						))}
						<Button size="xs" onClick={() => setReplaceSecret(true)}>
							<IconRefresh /> Replace
						</Button>
						<span className="text-[11px] text-muted-foreground">
							Encrypted at rest; never shown again.
						</span>
					</div>
				) : (
					<div className="grid gap-2 sm:grid-cols-2">
						{provider.secretFields.map((field) => (
							<FieldInput
								key={field.key}
								secret
								field={field}
								value={secret[field.key] ?? ""}
								onChange={(value) =>
									setSecret((current) => ({ ...current, [field.key]: value }))
								}
							/>
						))}
						{connection?.hasSecret && (
							<div className="flex items-end">
								<Button
									variant="ghost"
									onClick={() => {
										setReplaceSecret(false);
										setSecret({});
									}}
								>
									Keep stored credentials
								</Button>
							</div>
						)}
					</div>
				)}
			</fieldset>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<label className="flex items-center gap-1.5 text-xs">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
					/>
					Enabled for exports
				</label>
				<div className="flex gap-2">
					<Button variant="ghost" onClick={() => onDone()}>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="primary"
						disabled={
							save.isPending || !entityId || !name.trim() || missingSecret
						}
					>
						{connection ? "Save connection" : "Create connection"}
					</Button>
				</div>
			</div>
		</form>
	);
}
