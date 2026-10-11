/**
 * Column → field mapping editor with a live preview of the resulting orders
 * (runs the same pure transform as the import job on the preview rows).
 */
import {
	IconAlertTriangle,
	IconDeviceFloppy,
	IconFileImport,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	formatDate,
	ORDER_STATUS_TONES,
	STORE_META,
} from "#/components/app/format";
import {
	Button,
	Field,
	Input,
	Money,
	Panel,
	SectionLabel,
	Select,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import {
	listImportTemplates,
	saveImportTemplate,
	startImport,
} from "#/features/ingress/imports/imports-ui.functions";
import {
	buildPresetMapping,
	getPreset,
	IMPORT_PRESETS,
	type ImportPreset,
} from "#/features/ingress/imports/presets";
import { buildOrders } from "#/features/ingress/imports/transform";
import {
	FIELD_LABELS,
	type FieldSpec,
	type ImportMapping,
	ITEM_FIELDS,
	MONEY_ORDER_FIELDS,
	ORDER_FIELDS,
	type TargetField,
} from "#/features/ingress/imports/types";
import { cn } from "#/lib/utils";
import { STORE_IDS } from "#/shared/capture";

export const importKeys = {
	list: ["ledger", "imports", "list"] as const,
	one: (id: string) => ["ledger", "imports", "one", id] as const,
	templates: ["ledger", "imports", "templates"] as const,
};

export type EditorPreview = {
	headers: string[];
	rows: string[][];
	headerRow: number;
	totalRows: number;
};

const PREVIEW_ORDERS = 25;

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function MappingEditor({
	importId,
	fileName,
	preview,
	initialMapping,
	onStarted,
}: {
	importId: string;
	fileName: string;
	preview: EditorPreview;
	initialMapping: ImportMapping | null;
	onStarted?: () => void;
}) {
	const client = useQueryClient();
	const [mapping, setMapping] = useState<ImportMapping>(
		() =>
			initialMapping ??
			buildPresetMapping(
				(getPreset("generic-items") ?? IMPORT_PRESETS[0]) as ImportPreset,
				preview.headers,
			),
	);
	const [templateName, setTemplateName] = useState("");
	const templates = useQuery({
		queryKey: importKeys.templates,
		queryFn: () => listImportTemplates(),
	});

	const samples = useMemo(() => {
		const out = new Map<string, string[]>();
		preview.headers.forEach((header, index) => {
			const values: string[] = [];
			for (const row of preview.rows) {
				const value = (row[index] ?? "").trim();
				if (value && !values.includes(value)) values.push(value);
				if (values.length >= 3) break;
			}
			out.set(header, values);
		});
		return out;
	}, [preview]);

	const result = useMemo(
		() =>
			buildOrders({
				headers: preview.headers,
				rows: preview.rows,
				mapping,
				fileName,
				firstRowNumber: preview.headerRow + 2,
				maxErrors: 20,
			}),
		[preview, mapping, fileName],
	);
	const estimatedOrders =
		preview.totalRows <= preview.rows.length || result.dataRows === 0
			? result.orders.length
			: Math.max(
					result.orders.length,
					Math.round(
						(result.orders.length * preview.totalRows) / result.dataRows,
					),
				);
	const exact = preview.totalRows <= preview.rows.length;

	const setField = (field: TargetField, spec: FieldSpec | undefined) =>
		setMapping((current) => {
			const fields = { ...current.fields };
			const cleaned =
				spec && (spec.column || spec.constant || spec.fromFileName)
					? spec
					: undefined;
			if (cleaned) fields[field] = cleaned;
			else delete fields[field];
			return { ...current, fields };
		});
	const setOptions = (patch: Partial<ImportMapping["options"]>) =>
		setMapping((current) => ({
			...current,
			options: { ...current.options, ...patch },
		}));

	const start = useMutation({
		mutationFn: () => startImport({ data: { id: importId, mapping } }),
		onSuccess: () => {
			toast.success("Import queued");
			void client.invalidateQueries({ queryKey: ["ledger", "imports"] });
			onStarted?.();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const save = useMutation({
		mutationFn: () =>
			saveImportTemplate({
				data: { id: importId, name: templateName, mapping },
			}),
		onSuccess: () => {
			toast.success(`Saved template “${templateName}”`);
			setTemplateName("");
			void client.invalidateQueries({ queryKey: ["ledger", "imports"] });
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const fieldRows = (fields: readonly TargetField[]) =>
		fields.map((field) => (
			<FieldRow
				key={field}
				field={field}
				spec={mapping.fields[field]}
				headers={preview.headers}
				samples={samples}
				onChange={(spec) => setField(field, spec)}
			/>
		));

	return (
		<div className="flex flex-col gap-3">
			<Panel title="Mapping" bodyClassName="flex flex-col gap-3">
				<div className="grid grid-cols-2 gap-2 md:grid-cols-4">
					<Field label="Start from preset">
						<Select
							value=""
							onChange={(event) => {
								const preset = getPreset(event.target.value);
								if (preset)
									setMapping(buildPresetMapping(preset, preview.headers));
							}}
						>
							<option value="">
								{getPreset(mapping.presetId)?.name ?? "Choose…"}
							</option>
							{IMPORT_PRESETS.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label="Saved template">
						<Select
							value=""
							onChange={(event) => {
								const template = templates.data?.find(
									(t) => t.id === event.target.value,
								);
								if (template) setMapping(template.mapping);
							}}
						>
							<option value="">
								{templates.data?.length ? "Choose…" : "None saved"}
							</option>
							{(templates.data ?? []).map((template) => (
								<option key={template.id} value={template.id}>
									{template.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label="Store">
						<Select
							value={mapping.source}
							onChange={(event) =>
								setMapping((current) => ({
									...current,
									source: event.target.value,
								}))
							}
						>
							{STORE_IDS.map((id) => (
								<option key={id} value={id}>
									{STORE_META[id].label}
								</option>
							))}
						</Select>
					</Field>
					<Field label="Default currency">
						<Input
							value={mapping.options.currency ?? ""}
							maxLength={3}
							placeholder="USD"
							onChange={(event) =>
								setOptions({
									currency: event.target.value.toUpperCase() || undefined,
								})
							}
						/>
					</Field>
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
					<label className="inline-flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={!!mapping.options.dayFirst}
							onChange={(event) =>
								setOptions({ dayFirst: event.target.checked || undefined })
							}
						/>
						Day-first dates (31/12/2026)
					</label>
					<label className="inline-flex items-center gap-1.5">
						<input
							type="checkbox"
							checked={!!mapping.options.absoluteAmounts}
							onChange={(event) =>
								setOptions({
									absoluteAmounts: event.target.checked || undefined,
								})
							}
						/>
						Ignore minus signs
					</label>
					<span className="inline-flex flex-wrap items-center gap-1">
						<span className="text-muted-foreground">Sum per-row amounts:</span>
						{MONEY_ORDER_FIELDS.map((field) => {
							const on = mapping.options.sumFields?.includes(field) ?? false;
							return (
								<button
									key={field}
									type="button"
									onClick={() => {
										const current = new Set(mapping.options.sumFields ?? []);
										if (on) current.delete(field);
										else current.add(field);
										setOptions({
											sumFields: current.size ? [...current] : undefined,
										});
									}}
									className={cn(
										"h-5 rounded-sm border px-1.5 font-mono text-[10px] uppercase",
										on
											? "border-primary/40 bg-primary/12 text-primary"
											: "border-border text-muted-foreground hover:bg-accent",
									)}
								>
									{FIELD_LABELS[field]}
								</button>
							);
						})}
					</span>
				</div>
				{!!mapping.options.filters?.length && (
					<div className="flex flex-wrap items-center gap-1.5 text-xs">
						<span className="text-muted-foreground">Row filters:</span>
						{mapping.options.filters.map((filter, index) => (
							<span
								key={`${filter.column}-${filter.pattern}`}
								className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-muted px-1.5 font-mono text-[10px]"
							>
								{filter.column} {filter.negate ? "!~" : "~"} /{filter.pattern}/
								<button
									type="button"
									aria-label="Remove filter"
									className="text-muted-foreground hover:text-foreground"
									onClick={() =>
										setOptions({
											filters: mapping.options.filters?.filter(
												(_, i) => i !== index,
											),
										})
									}
								>
									<IconX className="size-3" />
								</button>
							</span>
						))}
					</div>
				)}
				<div className="overflow-x-auto">
					<table className="w-full min-w-[640px] text-xs">
						<thead>
							<tr className="label-caps text-left">
								<th className="w-36 py-1 pr-2 font-semibold">Field</th>
								<th className="w-56 py-1 pr-2 font-semibold">Column</th>
								<th className="w-40 py-1 pr-2 font-semibold">
									Constant / default
								</th>
								<th className="py-1 font-semibold">Sample values</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td colSpan={4} className="pt-2 pb-1">
									<SectionLabel>Order</SectionLabel>
								</td>
							</tr>
							{fieldRows(ORDER_FIELDS)}
							<tr>
								<td colSpan={4} className="pt-3 pb-1">
									<SectionLabel>Line item</SectionLabel>
								</td>
							</tr>
							{fieldRows(ITEM_FIELDS)}
						</tbody>
					</table>
				</div>
			</Panel>

			<Panel
				title={`Preview — ${result.orders.length} order${result.orders.length === 1 ? "" : "s"} from the first ${preview.rows.length} rows`}
				bodyClassName="p-0"
			>
				<PreviewTable result={result} source={mapping.source} />
				{(result.errors.length > 0 || result.skippedRows > 0) && (
					<div className="flex flex-col gap-1 border-t border-border px-3 py-2 text-xs">
						{result.skippedRows > 0 && (
							<div className="text-muted-foreground">
								{result.skippedRows} row{result.skippedRows === 1 ? "" : "s"}{" "}
								skipped by filters.
							</div>
						)}
						{result.errors.map((error) => (
							<div
								key={`${error.row}-${error.message}`}
								className="text-red-600 dark:text-red-400"
							>
								<span className="font-mono">Row {error.row}</span> ·{" "}
								{error.message}
							</div>
						))}
					</div>
				)}
			</Panel>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<Input
						className="w-56"
						placeholder="Template name (e.g. Mouser EU)"
						value={templateName}
						onChange={(event) => setTemplateName(event.target.value)}
					/>
					<Button
						disabled={!templateName.trim() || save.isPending}
						onClick={() => save.mutate()}
					>
						<IconDeviceFloppy />
						Save mapping as template
					</Button>
				</div>
				<Button
					variant="primary"
					size="md"
					disabled={start.isPending || result.orders.length === 0}
					onClick={() => start.mutate()}
				>
					<IconFileImport />
					{exact
						? `Import ${estimatedOrders} order${estimatedOrders === 1 ? "" : "s"}`
						: `Import ~${estimatedOrders} orders (${preview.totalRows} rows)`}
				</Button>
			</div>
		</div>
	);
}

const CONSTANT = "__constant__";

function FieldRow({
	field,
	spec,
	headers,
	samples,
	onChange,
}: {
	field: TargetField;
	spec: FieldSpec | undefined;
	headers: string[];
	samples: Map<string, string[]>;
	onChange: (spec: FieldSpec | undefined) => void;
}) {
	const column =
		spec?.column && headers.includes(spec.column) ? spec.column : "";
	const values = column ? (samples.get(column) ?? []) : [];
	return (
		<tr className="border-t border-border/60">
			<td className="py-1 pr-2 font-medium">{FIELD_LABELS[field]}</td>
			<td className="py-1 pr-2">
				<Select
					aria-label={`Column for ${FIELD_LABELS[field]}`}
					value={column}
					onChange={(event) => {
						const value = event.target.value;
						onChange({
							...spec,
							column: value && value !== CONSTANT ? value : undefined,
						});
					}}
				>
					<option value="">—</option>
					{headers.map((header) => (
						<option key={header} value={header}>
							{header}
						</option>
					))}
				</Select>
			</td>
			<td className="py-1 pr-2">
				<div className="flex items-center gap-1.5">
					<Input
						aria-label={`Constant for ${FIELD_LABELS[field]}`}
						value={spec?.constant ?? ""}
						placeholder={column ? "default" : "constant"}
						onChange={(event) =>
							onChange({ ...spec, constant: event.target.value || undefined })
						}
					/>
					{field === "externalOrderId" && (
						<label
							className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
							title="Use the longest number in the file name when the cell is empty"
						>
							<input
								type="checkbox"
								checked={!!spec?.fromFileName}
								onChange={(event) =>
									onChange({
										...spec,
										fromFileName: event.target.checked || undefined,
									})
								}
							/>
							file name
						</label>
					)}
				</div>
			</td>
			<td className="max-w-0 py-1">
				<div className="truncate font-mono text-[11px] text-muted-foreground">
					{values.length ? values.join(" · ") : column ? "(empty)" : ""}
				</div>
			</td>
		</tr>
	);
}

function PreviewTable({
	result,
	source,
}: {
	result: ReturnType<typeof buildOrders>;
	source: string;
}) {
	if (!result.orders.length)
		return (
			<div className="px-3 py-6 text-center text-xs text-muted-foreground">
				No orders yet — map at least an order ID (or a total) column.
			</div>
		);
	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[720px] text-xs">
				<thead>
					<tr className="label-caps h-7 border-b border-border text-left">
						<th className="px-3 font-semibold">Order</th>
						<th className="px-2 font-semibold">Date</th>
						<th className="px-2 font-semibold">Merchant</th>
						<th className="px-2 font-semibold">Items</th>
						<th className="px-2 text-right font-semibold">Total</th>
						<th className="px-2 font-semibold">Status</th>
						<th className="px-3 font-semibold">Notes</th>
					</tr>
				</thead>
				<tbody>
					{result.orders
						.slice(0, PREVIEW_ORDERS)
						.map(({ order, rows, warnings }) => (
							<tr
								key={`${order.merchantName ?? ""}-${order.externalOrderId}`}
								className="h-7 border-b border-border/60 last:border-0"
							>
								<td
									className="px-3 font-mono"
									title={`Rows ${rows.join(", ")}`}
								>
									{order.externalOrderId}
								</td>
								<td className="px-2 font-mono tabular-nums">
									{formatDate(order.orderDate)}
								</td>
								<td className="max-w-48 px-2">
									<div className="flex items-center gap-1.5 truncate">
										<StoreMark
											source={source}
											className="shrink-0 [&>span:last-child]:hidden"
										/>
										<span className="truncate">
											{order.merchantName ?? "—"}
										</span>
									</div>
								</td>
								<td
									className="max-w-64 truncate px-2"
									title={order.items
										?.map((i) => `${i.quantity}× ${i.title}`)
										.join("\n")}
								>
									{order.items?.length ? (
										<>
											<span className="font-mono">{order.items.length}</span>{" "}
											<span className="text-muted-foreground">
												{order.items[0]?.title}
											</span>
										</>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</td>
								<td className="px-2 text-right">
									<Money minor={order.totalMinor} currency={order.currency} />
								</td>
								<td className="px-2">
									{order.status ? (
										<Tag
											tone={ORDER_STATUS_TONES[order.status] ?? "neutral"}
											title={order.statusText}
										>
											{order.status}
										</Tag>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</td>
								<td className="px-3">
									{warnings.length > 0 && (
										<span
											className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"
											title={warnings.join("\n")}
										>
											<IconAlertTriangle className="size-3.5" />
											<span className="truncate">{warnings[0]}</span>
										</span>
									)}
								</td>
							</tr>
						))}
				</tbody>
			</table>
			{result.orders.length > PREVIEW_ORDERS && (
				<div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
					+{result.orders.length - PREVIEW_ORDERS} more orders in the preview
					rows
				</div>
			)}
		</div>
	);
}
