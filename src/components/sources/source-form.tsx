/** Create/edit form for any ingress source kind, generated from its fields. */
import { IconLock } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Select } from "#/components/app/primitives";
import { errorText, Switch } from "#/components/settings/ui";
import {
	createIngressSource,
	type listIngressSources,
	updateIngressSource,
} from "#/features/ingress/sources-ui.functions";

type ListResult = Awaited<ReturnType<typeof listIngressSources>>;
export type SourceKindMeta = ListResult["kinds"][number];
export type SourceRow = ListResult["sources"][number];
type FieldMeta = SourceKindMeta["configFields"][number];
type FieldValue = string | boolean;

export type CreatedSource = Awaited<ReturnType<typeof createIngressSource>>;

function initialValues(
	fields: FieldMeta[],
	stored: Record<string, unknown> | undefined,
): Record<string, FieldValue> {
	const out: Record<string, FieldValue> = {};
	for (const field of fields) {
		const value = stored?.[field.key];
		if (field.type === "checkbox")
			out[field.key] =
				value === undefined ? field.key === "tls" : value === true;
		else
			out[field.key] =
				value === undefined || value === null ? "" : String(value);
	}
	return out;
}

function toPayload(fields: FieldMeta[], values: Record<string, FieldValue>) {
	const out: Record<string, string | number | boolean> = {};
	for (const field of fields) {
		const value = values[field.key];
		if (field.type === "checkbox") out[field.key] = value === true;
		else if (typeof value === "string" && value.trim() !== "")
			out[field.key] = field.type === "number" ? Number(value) : value;
	}
	return out;
}

function FieldControl({
	field,
	value,
	onChange,
	secret,
	stored,
}: {
	field: FieldMeta;
	value: FieldValue;
	onChange: (value: FieldValue) => void;
	secret?: boolean;
	/** Editing with a stored secret: blank keeps it. */
	stored?: boolean;
}) {
	const label = (
		<>
			{field.label}
			{field.required && !stored && <span className="text-red-500"> *</span>}
		</>
	);
	if (field.type === "checkbox")
		return (
			<div className="flex items-center gap-2 py-1 text-xs">
				<Switch
					checked={value === true}
					onChange={(next) => onChange(next)}
					label={field.label}
				/>
				<span>{field.label}</span>
				{field.help && (
					<span className="text-[11px] text-muted-foreground">
						— {field.help}
					</span>
				)}
			</div>
		);
	if (field.type === "select")
		return (
			<Field label={label} hint={field.help}>
				<Select
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					required={field.required}
				>
					<option value="">—</option>
					{(field.options ?? []).map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</Select>
			</Field>
		);
	return (
		<Field
			label={label}
			hint={
				secret && stored
					? `${field.help ? `${field.help} ` : ""}Stored — leave blank to keep.`
					: field.help
			}
		>
			<div className="relative">
				<Input
					type={
						field.type === "password"
							? "password"
							: field.type === "number"
								? "number"
								: field.type === "url"
									? "url"
									: "text"
					}
					autoComplete={secret ? "new-password" : "off"}
					value={String(value)}
					placeholder={secret && stored ? "••••••••" : field.placeholder}
					required={field.required && !stored}
					onChange={(e) => onChange(e.target.value)}
					className={secret ? "pr-6" : undefined}
				/>
				{secret && (
					<IconLock className="pointer-events-none absolute top-1/2 right-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
				)}
			</div>
		</Field>
	);
}

export function SourceForm({
	meta,
	source,
	onDone,
}: {
	meta: SourceKindMeta;
	source?: SourceRow;
	onDone: (created?: CreatedSource) => void;
}) {
	const [name, setName] = useState(source?.name ?? meta.label);
	const [interval, setIntervalValue] = useState(
		String(source?.intervalMinutes ?? 10),
	);
	const [config, setConfig] = useState(() =>
		initialValues(meta.configFields, source?.config),
	);
	const [secret, setSecret] = useState(() =>
		initialValues(meta.secretFields, undefined),
	);
	const save = useMutation({
		mutationFn: async () => {
			const intervalMinutes = meta.push
				? undefined
				: Math.min(1440, Math.max(5, Number(interval) || 10));
			const configPayload = toPayload(meta.configFields, config);
			const secretPayload = toPayload(meta.secretFields, secret);
			if (source) {
				await updateIngressSource({
					data: {
						id: source.id,
						name,
						config: configPayload,
						secret: secretPayload,
						intervalMinutes,
					},
				});
				return undefined;
			}
			return createIngressSource({
				data: {
					kind: meta.kind,
					name,
					config: configPayload,
					secret: secretPayload,
					intervalMinutes,
				},
			});
		},
		onSuccess: (created) => {
			toast.success(source ? "Source saved" : "Source created");
			onDone(created);
		},
		onError: (error) => toast.error(errorText(error)),
	});

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				save.mutate();
			}}
		>
			<div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
				<Field label="Name">
					<Input
						value={name}
						required
						maxLength={120}
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
				{!meta.push && (
					<Field label="Every (minutes)">
						<Input
							type="number"
							min={5}
							max={1440}
							value={interval}
							onChange={(e) => setIntervalValue(e.target.value)}
						/>
					</Field>
				)}
			</div>
			{meta.configFields.length > 0 && (
				<div className="grid gap-3 sm:grid-cols-2">
					{meta.configFields.map((field) => (
						<div
							key={field.key}
							className={field.type === "checkbox" ? "sm:col-span-2" : ""}
						>
							<FieldControl
								field={field}
								value={config[field.key] ?? ""}
								onChange={(value) =>
									setConfig((prev) => ({ ...prev, [field.key]: value }))
								}
							/>
						</div>
					))}
				</div>
			)}
			{meta.secretFields.length > 0 && (
				<fieldset className="grid gap-3 rounded-sm border border-border p-3 sm:grid-cols-2">
					<legend className="label-caps px-1">
						Credentials (encrypted, write-only)
					</legend>
					{meta.secretFields.map((field) => (
						<FieldControl
							key={field.key}
							field={field}
							secret
							stored={Boolean(source?.hasSecret)}
							value={secret[field.key] ?? ""}
							onChange={(value) =>
								setSecret((prev) => ({ ...prev, [field.key]: value }))
							}
						/>
					))}
				</fieldset>
			)}
			<div className="flex gap-2">
				<Button type="submit" variant="primary" disabled={save.isPending}>
					{save.isPending ? "Saving…" : source ? "Save" : "Create source"}
				</Button>
				<Button variant="ghost" onClick={() => onDone()}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
