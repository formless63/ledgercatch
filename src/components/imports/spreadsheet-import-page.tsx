/** Spreadsheet (CSV/XLSX) import: upload, map, preview, import, history. */
import {
	IconFileSpreadsheet,
	IconLoader2,
	IconRefresh,
	IconTrash,
	IconUpload,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { formatRelative, type Tone } from "#/components/app/format";
import {
	Button,
	EmptyState,
	PageHeader,
	Panel,
	Select,
	StatTile,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import {
	changeImportSheet,
	deleteImport,
	getImport,
	listImports,
} from "#/features/ingress/imports/imports-ui.functions";
import { cn } from "#/lib/utils";
import { STORE_IDS, type StoreId } from "#/shared/capture";
import { importKeys, MappingEditor } from "./mapping-editor";

const STATUS_TONES: Record<string, Tone> = {
	uploaded: "neutral",
	mapped: "primary",
	processing: "info",
	done: "success",
	failed: "danger",
};
const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xlsm,.xls";
const MAX_BYTES = 25 * 1024 * 1024;
const linkButton =
	"inline-flex h-5 items-center rounded-sm border border-border bg-secondary px-1.5 text-[11px] text-secondary-foreground hover:bg-accent";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

const isStoreId = (value: string): value is StoreId =>
	(STORE_IDS as readonly string[]).includes(value);

export function SpreadsheetImportPage({
	selectedId,
	onSelect,
}: {
	selectedId?: string;
	onSelect: (id: string | undefined) => void;
}) {
	const client = useQueryClient();
	const list = useQuery({
		queryKey: importKeys.list,
		queryFn: () => listImports(),
		refetchInterval: (query) =>
			query.state.data?.some(
				(i) => i.status === "mapped" || i.status === "processing",
			)
				? 3000
				: 30_000,
	});

	const [uploading, setUploading] = useState(false);
	const upload = async (file: File) => {
		if (file.size > MAX_BYTES) {
			toast.error("File is larger than 25 MB");
			return;
		}
		setUploading(true);
		try {
			const body = new FormData();
			body.set("file", file);
			const response = await fetch("/api/imports/upload", {
				method: "POST",
				body,
			});
			const json = (await response.json().catch(() => ({}))) as {
				importId?: string;
				error?: string;
			};
			if (!response.ok || !json.importId)
				throw new Error(json.error ?? `Upload failed (${response.status})`);
			await client.invalidateQueries({ queryKey: ["ledger", "imports"] });
			onSelect(json.importId);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setUploading(false);
		}
	};

	return (
		<div className="flex min-h-full flex-col">
			<PageHeader
				title="Spreadsheet import"
				description="Import order history exports (CSV, TSV, XLSX) from Amazon, DigiKey, Mouser, eBay, AliExpress, PayPal or any store. Rows become captures and flow through the normal pipeline; re-importing the same file is safe."
				actions={
					<Button
						variant="ghost"
						aria-label="Refresh imports"
						onClick={() => void list.refetch()}
					>
						<IconRefresh />
					</Button>
				}
			/>
			<div className="flex flex-col gap-4 p-4">
				<DropZone busy={uploading} onFile={(file) => void upload(file)} />
				{selectedId && (
					<SelectedImport
						key={selectedId}
						id={selectedId}
						onClose={() => onSelect(undefined)}
					/>
				)}
				<ImportHistory
					imports={list.data ?? []}
					loading={list.isLoading}
					selectedId={selectedId}
					onSelect={onSelect}
				/>
			</div>
		</div>
	);
}

function DropZone({
	busy,
	onFile,
}: {
	busy: boolean;
	onFile: (file: File) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setOver(false);
		const file = event.dataTransfer.files[0];
		if (file) onFile(file);
	};
	return (
		<button
			type="button"
			disabled={busy}
			onClick={() => input.current?.click()}
			onDragOver={(event) => {
				event.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={onDrop}
			className={cn(
				"flex w-full flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border bg-card px-6 py-8 text-center transition-colors hover:bg-accent/40",
				over && "border-primary bg-primary/5",
				busy && "opacity-70",
			)}
		>
			{busy ? (
				<IconLoader2 className="size-6 animate-spin text-muted-foreground" />
			) : (
				<IconUpload className="size-6 text-muted-foreground" />
			)}
			<span className="text-sm font-semibold">
				{busy ? "Reading file…" : "Drop a CSV or Excel export here"}
			</span>
			<span className="text-xs text-muted-foreground">
				or click to choose · .csv .tsv .xlsx · max 25 MB · legacy .xls: save as
				.xlsx first
			</span>
			<input
				ref={input}
				type="file"
				accept={ACCEPT}
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) onFile(file);
					event.target.value = "";
				}}
			/>
		</button>
	);
}

function SelectedImport({ id, onClose }: { id: string; onClose: () => void }) {
	const client = useQueryClient();
	const [editing, setEditing] = useState(false);
	const query = useQuery({
		queryKey: importKeys.one(id),
		queryFn: () => getImport({ data: { id } }),
		refetchInterval: (q) =>
			q.state.data?.status === "mapped" || q.state.data?.status === "processing"
				? 2000
				: false,
	});
	const sheet = useMutation({
		mutationFn: (name: string) =>
			changeImportSheet({ data: { id, sheet: name } }),
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["ledger", "imports"] }),
		onError: (error) => toast.error(errorMessage(error)),
	});

	const data = query.data;
	if (query.isLoading)
		return (
			<Panel title="Import">
				<div className="text-xs text-muted-foreground">Loading…</div>
			</Panel>
		);
	if (!data || !data.preview)
		return (
			<Panel
				title="Import"
				action={
					<Button size="xs" variant="ghost" onClick={onClose}>
						Close
					</Button>
				}
			>
				<div className="text-xs text-muted-foreground">
					{query.error ? errorMessage(query.error) : "Import not found."}
				</div>
			</Panel>
		);
	const preview = data.preview;
	const running = data.status === "mapped" || data.status === "processing";
	const showEditor =
		!running &&
		(editing || data.status === "uploaded" || data.status === "failed");

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2 rounded border border-border bg-card px-3 py-2">
				<IconFileSpreadsheet className="size-4 text-muted-foreground" />
				<span className="truncate text-sm font-semibold">{data.fileName}</span>
				<Tag tone={STATUS_TONES[data.status] ?? "neutral"}>{data.status}</Tag>
				{data.detected && (
					<Tag
						tone={data.detected.kind === "template" ? "primary" : "info"}
						title={`Detected ${data.detected.kind}`}
					>
						{data.detected.kind === "template" ? "Template" : "Preset"}:{" "}
						{data.detected.name}
					</Tag>
				)}
				<span className="font-mono text-[11px] text-muted-foreground">
					{preview.format.toUpperCase()} · {preview.headers.length} cols ·{" "}
					{preview.totalRows} rows
				</span>
				{preview.sheets.length > 1 && (
					<div className="ml-auto flex items-center gap-1.5 text-xs">
						<span className="label-caps">Sheet</span>
						<Select
							aria-label="Worksheet"
							className="w-40"
							value={preview.sheet ?? ""}
							disabled={sheet.isPending || running}
							onChange={(event) => sheet.mutate(event.target.value)}
						>
							{preview.sheets.map((name) => (
								<option key={name} value={name}>
									{name}
								</option>
							))}
						</Select>
					</div>
				)}
				<Button
					size="xs"
					variant="ghost"
					className={preview.sheets.length > 1 ? "" : "ml-auto"}
					onClick={onClose}
				>
					Close
				</Button>
			</div>

			{data.error && (
				<div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
					{data.error}
				</div>
			)}

			{running && (
				<div className="flex items-center gap-2 rounded border border-border bg-card px-3 py-3 text-xs">
					<IconLoader2 className="size-4 animate-spin text-primary" />
					{data.status === "mapped"
						? "Queued — waiting for the worker…"
						: "Importing rows… orders appear as their captures are parsed."}
				</div>
			)}

			{data.status === "done" && !editing && (
				<ImportResult data={data} onRemap={() => setEditing(true)} />
			)}

			{showEditor && (
				<MappingEditor
					key={`${preview.sheet ?? ""}:${preview.headers.join("|")}`}
					importId={id}
					fileName={data.fileName}
					preview={preview}
					initialMapping={data.mapping}
					onStarted={() => setEditing(false)}
				/>
			)}
		</div>
	);
}

type ImportRow = Awaited<ReturnType<typeof listImports>>[number];

function ordersLink(row: ImportRow) {
	return {
		source: row.source,
		from: row.stats?.minDate,
		to: row.stats?.maxDate,
	};
}

function ImportResult({
	data,
	onRemap,
}: {
	data: ImportRow;
	onRemap: () => void;
}) {
	const stats = data.stats;
	return (
		<Panel
			title="Result"
			action={
				<div className="flex items-center gap-1.5">
					<Link
						to="/app/orders"
						search={ordersLink(data)}
						className={linkButton}
					>
						View orders
					</Link>
					{isStoreId(data.source) && (
						<Link
							to="/app/captures"
							search={{ source: data.source }}
							className={linkButton}
						>
							Captures
						</Link>
					)}
					<Button size="xs" variant="ghost" onClick={onRemap}>
						Edit mapping & re-run
					</Button>
				</div>
			}
			bodyClassName="flex flex-col gap-3"
		>
			<div className="grid grid-cols-2 gap-2 md:grid-cols-5">
				<StatTile label="Rows" value={data.rowCount} />
				<StatTile label="Orders" value={stats?.orders ?? "—"} />
				<StatTile
					label="New orders"
					value={data.ordersCreated}
					tone="success"
				/>
				<StatTile label="Updated" value={data.ordersUpdated} tone="primary" />
				<StatTile
					label="Unchanged"
					value={stats?.unchanged ?? 0}
					hint="Already imported"
				/>
			</div>
			{(stats?.skippedRows ?? 0) > 0 && (
				<div className="text-xs text-muted-foreground">
					{stats?.skippedRows} rows skipped by filters.
				</div>
			)}
			<ErrorList
				errors={data.errors}
				total={stats?.errorRows ?? data.errors.length}
			/>
		</Panel>
	);
}

function ErrorList({
	errors,
	total,
}: {
	errors: Array<{ row: number; message: string }>;
	total: number;
}) {
	if (!errors.length) return null;
	return (
		<div className="flex flex-col gap-0.5 text-xs">
			<div className="label-caps text-red-600 dark:text-red-400">
				{total} row error{total === 1 ? "" : "s"}
				{total > errors.length ? ` (first ${errors.length})` : ""}
			</div>
			<div className="max-h-48 overflow-y-auto rounded border border-border">
				{errors.map((error, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						key={index}
						className="flex gap-2 border-b border-border/60 px-2 py-1 last:border-0"
					>
						<span className="w-14 shrink-0 font-mono text-muted-foreground">
							Row {error.row}
						</span>
						<span>{error.message}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function ImportHistory({
	imports,
	loading,
	selectedId,
	onSelect,
}: {
	imports: ImportRow[];
	loading: boolean;
	selectedId?: string;
	onSelect: (id: string | undefined) => void;
}) {
	const client = useQueryClient();
	const remove = useMutation({
		mutationFn: (id: string) => deleteImport({ data: { id } }),
		onSuccess: (_, id) => {
			if (id === selectedId) onSelect(undefined);
			void client.invalidateQueries({ queryKey: ["ledger", "imports"] });
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	return (
		<Panel title="History" bodyClassName="p-0">
			{!imports.length ? (
				<EmptyState
					className="m-3"
					icon={<IconFileSpreadsheet />}
					title={loading ? "Loading…" : "No imports yet"}
				>
					Upload an order history export above. Mappings you save as templates
					are detected automatically next time.
				</EmptyState>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[860px] text-xs">
						<thead>
							<tr className="label-caps h-7 border-b border-border text-left">
								<th className="px-3 font-semibold">File</th>
								<th className="px-2 font-semibold">Store</th>
								<th className="px-2 font-semibold">Status</th>
								<th className="px-2 text-right font-semibold">Rows</th>
								<th className="px-2 text-right font-semibold">New</th>
								<th className="px-2 text-right font-semibold">Updated</th>
								<th className="px-2 text-right font-semibold">Unchanged</th>
								<th className="px-2 text-right font-semibold">Errors</th>
								<th className="px-2 font-semibold">When</th>
								<th className="px-3" />
							</tr>
						</thead>
						<tbody>
							{imports.map((row) => (
								<tr
									key={row.id}
									className={cn(
										"h-7 border-b border-border/60 last:border-0 hover:bg-accent/40",
										row.id === selectedId && "bg-accent/60",
									)}
								>
									<td className="max-w-64 px-3">
										<button
											type="button"
											className="max-w-full truncate text-left hover:text-primary hover:underline"
											title={row.fileName}
											onClick={() => onSelect(row.id)}
										>
											{row.fileName}
										</button>
									</td>
									<td className="px-2">
										<StoreMark source={row.source} />
									</td>
									<td className="px-2">
										<Tag
											tone={STATUS_TONES[row.status] ?? "neutral"}
											title={row.error ?? undefined}
										>
											{row.status}
										</Tag>
									</td>
									<td className="px-2 text-right font-mono tabular-nums">
										{row.rowCount}
									</td>
									<td className="px-2 text-right font-mono tabular-nums">
										{row.status === "done" ? row.ordersCreated : "—"}
									</td>
									<td className="px-2 text-right font-mono tabular-nums">
										{row.status === "done" ? row.ordersUpdated : "—"}
									</td>
									<td className="px-2 text-right font-mono tabular-nums">
										{row.stats?.unchanged ?? "—"}
									</td>
									<td
										className={cn(
											"px-2 text-right font-mono tabular-nums",
											(row.stats?.errorRows ?? 0) > 0 &&
												"text-red-600 dark:text-red-400",
										)}
									>
										{row.stats?.errorRows ?? "—"}
									</td>
									<td className="px-2 font-mono text-muted-foreground">
										{formatRelative(row.createdAt)}
									</td>
									<td className="px-3">
										<div className="flex items-center justify-end gap-1">
											{row.status === "done" && (
												<Link
													to="/app/orders"
													search={ordersLink(row)}
													className={linkButton}
												>
													Orders
												</Link>
											)}
											<Button
												size="xs"
												variant="ghost"
												aria-label={`Delete import ${row.fileName}`}
												title="Remove from history (imported orders stay)"
												disabled={
													row.status === "processing" || remove.isPending
												}
												onClick={() => remove.mutate(row.id)}
											>
												<IconTrash />
											</Button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Panel>
	);
}
