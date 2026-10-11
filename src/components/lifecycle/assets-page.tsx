/** Asset register (#13): list, filter (expiring warranty), edit, CSV export. */
import {
	IconDeviceLaptop,
	IconDownload,
	IconFileInvoice,
	IconPencil,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatDate, storeLabel } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Input,
	Money,
	PageHeader,
	Select,
	StatTile,
	Tag,
} from "#/components/app/primitives";
import { downloadText, errorMessage } from "#/components/orders/shared";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import { assetsToCsv, warrantyState } from "#/features/lifecycle/assets";
import type { AssetRow } from "#/features/lifecycle/assets.server";
import { lifecycleKeys } from "#/features/lifecycle/hooks";
import {
	deleteAsset,
	listAssets,
} from "#/features/lifecycle/lifecycle.functions";
import { ASSET_STATUSES, type AssetStatus } from "#/features/lifecycle/schema";
import {
	ASSET_STATUS_LABELS,
	AssetDialog,
	type AssetDraft,
} from "./asset-dialog";
import { todayIso } from "./shared";

export type AssetsSearch = {
	status?: AssetStatus;
	entity?: string;
	expiring?: number;
	q?: string;
};

const WARRANTY_TONES = {
	none: "neutral",
	active: "success",
	expiring: "warning",
	expired: "danger",
} as const;

export function AssetsPage({
	search,
	onSearch,
}: {
	search: AssetsSearch;
	onSearch: (next: Partial<AssetsSearch>) => void;
}) {
	const { activeEntities, entityById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [q, setQ] = useState(search.q ?? "");
	const [editing, setEditing] = useState<AssetDraft | null>(null);
	useEffect(() => {
		const t = setTimeout(() => {
			if ((search.q ?? "") !== q) onSearch({ q: q || undefined });
		}, 250);
		return () => clearTimeout(t);
	}, [q, search.q, onSearch]);

	const filters = {
		status: search.status,
		entityId: search.entity,
		expiringWithinDays: search.expiring,
		q: search.q,
	};
	const query = useQuery({
		queryKey: lifecycleKeys.assets(filters),
		queryFn: () => listAssets({ data: filters }),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteAsset({ data: { id } }),
		onSuccess: () => {
			toast.success("Asset deleted");
			void invalidate();
		},
		onError: (e) => toast.error(errorMessage(e)),
	});

	const rows = query.data ?? [];
	const today = todayIso();
	const expiringCount = rows.filter(
		(r) => warrantyState(r.warrantyExpiresAt, today) === "expiring",
	).length;

	const exportCsv = () => {
		const csv = assetsToCsv(
			rows.map((r) => ({
				name: r.name,
				serial: r.serial,
				status: r.status,
				entityName: r.entityId
					? (entityById.get(r.entityId)?.name ?? null)
					: null,
				purchaseDate: r.purchaseDate,
				warrantyMonths: r.warrantyMonths,
				warrantyExpiresAt: r.warrantyExpiresAt,
				location: r.location,
				source: r.source ? storeLabel(r.source) : null,
				externalOrderId: r.externalOrderId,
				unitPriceMinor: r.unitPriceMinor,
				currency: r.currency,
				notes: r.notes,
			})),
		);
		downloadText(`assets-${today}.csv`, csv, "text/csv;charset=utf-8");
	};

	return (
		<div className="flex flex-col">
			<PageHeader
				title="Assets"
				description="Equipment register: serials, warranty, location. Register items from an order's line items."
				actions={
					<>
						<Button onClick={exportCsv} disabled={rows.length === 0}>
							<IconDownload />
							CSV
						</Button>
						<Button
							variant="primary"
							onClick={() => setEditing({ name: "", warrantyMonths: 12 })}
						>
							<IconPlus />
							New asset
						</Button>
					</>
				}
			/>
			<div className="grid grid-cols-2 gap-2 px-3 pt-3 sm:grid-cols-4 sm:px-4">
				<StatTile label="Assets" value={rows.length} />
				<StatTile
					label="In service"
					value={rows.filter((r) => r.status === "in_service").length}
				/>
				<StatTile
					label="Warranty ≤ 60d"
					value={expiringCount}
					tone={expiringCount ? "warning" : undefined}
				/>
				<StatTile
					label="No serial"
					value={rows.filter((r) => !r.serial).length}
				/>
			</div>
			<div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
				<Input
					aria-label="Search assets"
					placeholder="Search name, serial, location…"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					className="w-64"
				/>
				<Select
					aria-label="Status"
					value={search.status ?? ""}
					className="w-32"
					onChange={(e) =>
						onSearch({
							status: (e.target.value || undefined) as AssetStatus | undefined,
						})
					}
				>
					<option value="">All statuses</option>
					{ASSET_STATUSES.map((s) => (
						<option key={s} value={s}>
							{ASSET_STATUS_LABELS[s]}
						</option>
					))}
				</Select>
				<Select
					aria-label="Entity"
					value={search.entity ?? ""}
					className="w-40"
					onChange={(e) => onSearch({ entity: e.target.value || undefined })}
				>
					<option value="">All entities</option>
					{activeEntities.map((e) => (
						<option key={e.id} value={e.id}>
							{e.name}
						</option>
					))}
				</Select>
				<Select
					aria-label="Warranty"
					value={search.expiring ? String(search.expiring) : ""}
					className="w-44"
					onChange={(e) =>
						onSearch({
							expiring: e.target.value ? Number(e.target.value) : undefined,
						})
					}
				>
					<option value="">Any warranty</option>
					<option value="30">Expiring ≤ 30 days</option>
					<option value="60">Expiring ≤ 60 days</option>
					<option value="90">Expiring ≤ 90 days</option>
					<option value="365">Expiring ≤ 1 year</option>
				</Select>
			</div>

			<div className="px-3 pb-4 sm:px-4">
				{query.isPending ? (
					<div className="h-40 animate-pulse rounded bg-muted" />
				) : query.isError ? (
					<EmptyState title="Could not load assets">
						{errorMessage(query.error)}
					</EmptyState>
				) : rows.length === 0 ? (
					<EmptyState
						icon={<IconDeviceLaptop className="size-6" />}
						title="No assets"
					>
						Open an order and use “Asset” on a line item to register equipment
						with its serial number and warranty.
					</EmptyState>
				) : (
					<div className="overflow-x-auto rounded border border-border bg-card">
						<table className="w-full min-w-[860px] border-collapse text-xs">
							<thead>
								<tr className="h-7 border-b border-border text-left">
									<th className="label-caps px-2">Asset</th>
									<th className="label-caps w-36 px-2">Entity</th>
									<th className="label-caps w-20 px-2">Bought</th>
									<th className="label-caps w-32 px-2">Warranty</th>
									<th className="label-caps w-36 px-2">Location</th>
									<th className="label-caps w-24 px-2">Status</th>
									<th className="label-caps w-40 px-2">Order</th>
									<th className="label-caps w-20 px-2 text-right">Price</th>
									<th className="w-20 px-2">
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((row) => (
									<AssetTableRow
										key={row.id}
										row={row}
										today={today}
										onEdit={() =>
											setEditing({
												id: row.id,
												orderItemId: row.orderItemId,
												orderId: row.orderId,
												entityId: row.entityId,
												name: row.name,
												serial: row.serial,
												purchaseDate: row.purchaseDate,
												warrantyMonths: row.warrantyMonths,
												warrantyExpiresAt: row.warrantyExpiresAt,
												location: row.location,
												notes: row.notes,
												status: row.status,
											})
										}
										onDelete={() => {
											if (window.confirm(`Delete asset “${row.name}”?`))
												remove.mutate(row.id);
										}}
									/>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
			{editing && (
				<AssetDialog
					key={editing.id ?? "new"}
					open
					onOpenChange={(open) => {
						if (!open) setEditing(null);
					}}
					initial={editing}
				/>
			)}
		</div>
	);
}

function AssetTableRow({
	row,
	today,
	onEdit,
	onDelete,
}: {
	row: AssetRow;
	today: string;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const { entityById } = useBootstrap();
	const state = warrantyState(row.warrantyExpiresAt, today);
	return (
		<tr className="h-8 border-b border-border/60 last:border-0 hover:bg-accent/40">
			<td className="max-w-0 px-2">
				<div className="truncate font-medium" title={row.name}>
					{row.name}
				</div>
				<div className="truncate font-mono text-[10px] text-muted-foreground">
					{row.serial ? `SN ${row.serial}` : "no serial"}
				</div>
			</td>
			<td className="px-2">
				{row.entityId ? (
					<EntityChip entity={entityById.get(row.entityId)} short />
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</td>
			<td className="px-2 font-mono text-[11px]">
				{formatDate(row.purchaseDate)}
			</td>
			<td className="px-2">
				<span className="flex items-center gap-1.5">
					<span className="font-mono text-[11px]">
						{formatDate(row.warrantyExpiresAt)}
					</span>
					{state !== "none" && state !== "active" && (
						<Tag tone={WARRANTY_TONES[state]}>{state}</Tag>
					)}
				</span>
			</td>
			<td className="max-w-0 truncate px-2 text-muted-foreground">
				{row.location ?? "—"}
			</td>
			<td className="px-2">
				<Tag tone={row.status === "in_service" ? "primary" : "neutral"}>
					{ASSET_STATUS_LABELS[row.status]}
				</Tag>
			</td>
			<td className="max-w-0 px-2">
				{row.orderId ? (
					<Link
						to="/app/orders/$orderId"
						params={{ orderId: row.orderId }}
						className="block truncate font-mono text-[11px] hover:underline"
						title={row.merchantName ?? undefined}
					>
						{row.source ? `${storeLabel(row.source)} · ` : ""}
						{row.externalOrderId}
					</Link>
				) : (
					<span className="text-muted-foreground">manual</span>
				)}
			</td>
			<td className="px-2 text-right">
				<Money minor={row.unitPriceMinor} currency={row.currency} />
			</td>
			<td className="px-2">
				<span className="flex justify-end gap-0.5">
					{row.documents[0] && (
						<a
							href={`/api/documents/${row.documents[0].id}`}
							target="_blank"
							rel="noreferrer"
							className="inline-flex h-5 items-center rounded-sm px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							title={row.documents
								.map((d) => `${d.kind}: ${d.fileName}`)
								.join("\n")}
						>
							<IconFileInvoice className="size-3.5" />
						</a>
					)}
					<Button
						size="xs"
						variant="ghost"
						aria-label="Edit asset"
						onClick={onEdit}
					>
						<IconPencil />
					</Button>
					<Button
						size="xs"
						variant="ghost"
						aria-label="Delete asset"
						onClick={onDelete}
					>
						<IconTrash />
					</Button>
				</span>
			</td>
		</tr>
	);
}
