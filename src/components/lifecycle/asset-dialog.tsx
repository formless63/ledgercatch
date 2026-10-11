/** Create/edit an asset (#13); "Register as asset" action for order items. */
import { IconDeviceLaptop } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
	Button,
	Field,
	Input,
	Select,
	Tag,
	Textarea,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/orders/shared";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import type { OrderDetail } from "#/features/ledger/ledger.server";
import { warrantyExpiry } from "#/features/lifecycle/assets";
import { lifecycleKeys } from "#/features/lifecycle/hooks";
import {
	getOrderAssets,
	saveAsset,
} from "#/features/lifecycle/lifecycle.functions";
import { ASSET_STATUSES, type AssetStatus } from "#/features/lifecycle/schema";
import { FormDialog } from "./shared";

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
	in_service: "In service",
	retired: "Retired",
	sold: "Sold",
};

export type AssetDraft = {
	id?: string;
	orderItemId?: string | null;
	orderId?: string | null;
	entityId?: string | null;
	name: string;
	serial?: string | null;
	purchaseDate?: string | null;
	warrantyMonths?: number | null;
	warrantyExpiresAt?: string | null;
	location?: string | null;
	notes?: string | null;
	status?: AssetStatus;
};

export function AssetDialog({
	open,
	onOpenChange,
	initial,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initial: AssetDraft;
}) {
	const { activeEntities } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const toForm = (draft: AssetDraft) => ({
		name: draft.name,
		serial: draft.serial ?? "",
		entityId: draft.entityId ?? "",
		purchaseDate: draft.purchaseDate ?? "",
		warrantyMonths:
			draft.warrantyMonths != null ? String(draft.warrantyMonths) : "",
		// Only an explicit date the months do not explain is kept as override.
		warrantyExpiresAt:
			draft.warrantyExpiresAt &&
			draft.warrantyExpiresAt !==
				warrantyExpiry({
					purchaseDate: draft.purchaseDate,
					warrantyMonths: draft.warrantyMonths,
				})
				? draft.warrantyExpiresAt
				: "",
		location: draft.location ?? "",
		notes: draft.notes ?? "",
		status: draft.status ?? ("in_service" as AssetStatus),
	});
	const [form, setForm] = useState(() => toForm(initial));
	const [error, setError] = useState<string | null>(null);
	const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
		setForm((f) => ({ ...f, [key]: value }));

	const months = form.warrantyMonths ? Number(form.warrantyMonths) : null;
	const computed = warrantyExpiry({
		purchaseDate: form.purchaseDate || null,
		warrantyMonths: months,
		warrantyExpiresAt: form.warrantyExpiresAt || null,
	});

	const save = useMutation({
		mutationFn: () =>
			saveAsset({
				data: {
					id: initial.id,
					orderItemId: initial.orderItemId ?? null,
					orderId: initial.orderId ?? null,
					entityId: form.entityId || null,
					name: form.name,
					serial: form.serial || null,
					purchaseDate: form.purchaseDate || null,
					warrantyMonths: months,
					warrantyExpiresAt: form.warrantyExpiresAt || null,
					location: form.location || null,
					notes: form.notes || null,
					status: form.status,
				},
			}),
		onSuccess: () => {
			toast.success(initial.id ? "Asset saved" : "Asset registered");
			void invalidate();
			onOpenChange(false);
		},
		onError: (e) => setError(errorMessage(e)),
	});

	return (
		<FormDialog
			open={open}
			onOpenChange={(next) => {
				if (next) setForm(toForm(initial));
				setError(null);
				onOpenChange(next);
			}}
			title={initial.id ? "Edit asset" : "Register as asset"}
			description="Track serial number, warranty and location for this item."
			submitLabel={initial.id ? "Save" : "Register"}
			pending={save.isPending}
			error={error}
			onSubmit={() => {
				if (!form.name.trim()) return setError("Name is required");
				if (months != null && (!Number.isInteger(months) || months < 0))
					return setError("Warranty months must be a whole number");
				save.mutate();
			}}
		>
			<Field label="Name" className="col-span-2">
				<Input
					autoFocus
					required
					value={form.name}
					onChange={(e) => set("name", e.target.value)}
				/>
			</Field>
			<Field label="Serial number">
				<Input
					value={form.serial}
					onChange={(e) => set("serial", e.target.value)}
				/>
			</Field>
			<Field label="Entity">
				<Select
					value={form.entityId}
					onChange={(e) => set("entityId", e.target.value)}
				>
					<option value="">
						{initial.orderItemId ? "From order" : "None"}
					</option>
					{activeEntities.map((e) => (
						<option key={e.id} value={e.id}>
							{e.name}
						</option>
					))}
				</Select>
			</Field>
			<Field label="Purchase / in-service date">
				<Input
					type="date"
					value={form.purchaseDate}
					onChange={(e) => set("purchaseDate", e.target.value)}
				/>
			</Field>
			<Field label="Warranty (months)">
				<Input
					inputMode="numeric"
					value={form.warrantyMonths}
					onChange={(e) =>
						set("warrantyMonths", e.target.value.replace(/\D/g, ""))
					}
					placeholder="12"
				/>
			</Field>
			<Field
				label="Warranty ends"
				hint={
					!form.warrantyExpiresAt && computed
						? `Computed: ${computed}`
						: undefined
				}
			>
				<Input
					type="date"
					value={form.warrantyExpiresAt}
					onChange={(e) => set("warrantyExpiresAt", e.target.value)}
				/>
			</Field>
			<Field label="Status">
				<Select
					value={form.status}
					onChange={(e) => set("status", e.target.value as AssetStatus)}
				>
					{ASSET_STATUSES.map((s) => (
						<option key={s} value={s}>
							{ASSET_STATUS_LABELS[s]}
						</option>
					))}
				</Select>
			</Field>
			<Field label="Location" className="col-span-2">
				<Input
					value={form.location}
					onChange={(e) => set("location", e.target.value)}
					placeholder="Office rack, home lab, Alice's desk…"
				/>
			</Field>
			<Field label="Notes" className="col-span-2">
				<Textarea
					rows={2}
					value={form.notes}
					onChange={(e) => set("notes", e.target.value)}
				/>
			</Field>
			{!initial.id && initial.orderId && (
				<p className="col-span-2 text-[11px] text-muted-foreground">
					The order's invoices and receipts are attached automatically.
				</p>
			)}
		</FormDialog>
	);
}

export function useOrderAssets(orderId: string) {
	return useQuery({
		queryKey: lifecycleKeys.orderAssets(orderId),
		queryFn: () => getOrderAssets({ data: { orderId } }),
	});
}

/**
 * Per-item action for the order detail items table: shows the registered
 * asset(s) or a "Register as asset" button.
 */
export function RegisterAssetButton({
	detail,
	item,
}: {
	detail: OrderDetail;
	item: OrderDetail["items"][number];
}) {
	const [open, setOpen] = useState(false);
	const assets = useOrderAssets(detail.order.id);
	const registered = (assets.data ?? []).filter(
		(a) => a.orderItemId === item.id,
	);
	if (registered.length > 0)
		return (
			<Link
				to="/app/assets"
				className="inline-flex"
				title={registered
					.map((a) => `${a.name}${a.serial ? ` · SN ${a.serial}` : ""}`)
					.join("\n")}
			>
				<Tag tone="success">
					<IconDeviceLaptop className="size-3" />
					{registered.length > 1 ? `${registered.length} assets` : "Asset"}
				</Tag>
			</Link>
		);
	return (
		<>
			<Button
				size="xs"
				variant="ghost"
				onClick={() => setOpen(true)}
				title="Register as asset"
				aria-label={`Register ${item.title} as asset`}
			>
				<IconDeviceLaptop />
				<span className="hidden xl:inline">Asset</span>
			</Button>
			{open && (
				<AssetDialog
					open={open}
					onOpenChange={setOpen}
					initial={{
						orderItemId: item.id,
						orderId: detail.order.id,
						name: item.title.slice(0, 300),
						purchaseDate: detail.order.orderDate,
						warrantyMonths: 12,
					}}
				/>
			)}
		</>
	);
}
