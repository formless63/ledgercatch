import {
	IconArchive,
	IconArrowBackUp,
	IconBuildingStore,
	IconChevronDown,
	IconChevronUp,
	IconPencil,
	IconPlus,
	IconSparkles,
	IconStar,
	IconStarFilled,
	IconTrash,
	IconUser,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	Button,
	EntityChip,
	Field,
	Input,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import {
	type EntityRow,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import { ENTITY_COLOR_OPTIONS } from "#/features/ledger/inputs";
import { saveEntity } from "#/features/ledger/ledger.functions";
import {
	onboardEntities,
	reorderEntities,
} from "#/features/ledger/settings-ui.functions";
import { cn } from "#/lib/utils";
import { Callout, ColorPicker, type EntityColor, errorText } from "./ui";

type EntityDraft = {
	name: string;
	shortName: string;
	kind: "personal" | "business";
	color: EntityColor;
	isDefault: boolean;
};

const nextColor = (used: string[]): EntityColor =>
	ENTITY_COLOR_OPTIONS.find((c) => !used.includes(c)) ?? "sky";

/* ───────────────────────── onboarding ───────────────────────── */

const STARTER_CATEGORIES = [
	"Electronic components",
	"Tools & equipment",
	"Office supplies",
	"Software & subscriptions",
	"Shipping & postage",
	"Household",
];

export function EntityOnboarding() {
	const invalidate = useInvalidateLedger();
	const [rows, setRows] = useState<EntityDraft[]>([
		{
			name: "Personal",
			shortName: "PERS",
			kind: "personal",
			color: "indigo",
			isDefault: true,
		},
		{
			name: "",
			shortName: "",
			kind: "business",
			color: "emerald",
			isDefault: false,
		},
	]);
	const [withCategories, setWithCategories] = useState(true);
	const valid = rows.filter((row) => row.name.trim());
	const create = useMutation({
		mutationFn: () =>
			onboardEntities({
				data: {
					entities: valid.map((row) => ({
						name: row.name.trim(),
						shortName: row.shortName.trim() || null,
						kind: row.kind,
						color: row.color,
						isDefault: row.isDefault,
					})),
					categories: withCategories ? STARTER_CATEGORIES : [],
				},
			}),
		onSuccess: async (result) => {
			toast.success(
				`Created ${result.entityIds.length} entit${result.entityIds.length === 1 ? "y" : "ies"}`,
			);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const update = (index: number, patch: Partial<EntityDraft>) =>
		setRows((current) =>
			current.map((row, i) => {
				if (patch.isDefault && i !== index) return { ...row, isDefault: false };
				return i === index ? { ...row, ...patch } : row;
			}),
		);

	return (
		<section className="rounded border border-primary/40 bg-card">
			<header className="flex items-center gap-2 border-b border-border px-3 py-2">
				<IconSparkles className="size-4 text-primary" />
				<h2 className="text-sm font-semibold">Set up your entities</h2>
			</header>
			<div className="space-y-3 p-3">
				<p className="text-xs text-muted-foreground">
					Entities are who a purchase is <em>for</em>: you personally, plus each
					business you buy for. Every order gets an entity; when the card that
					paid belongs to a different entity, the amount becomes reimbursable.
					You can rename, recolor and add more later.
				</p>
				<div className="space-y-2">
					{rows.map((row, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: editable draft list
							key={index}
							className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-sm border border-border bg-background/40 p-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,0.7fr)_auto_auto_auto]"
						>
							<Field label="Name">
								<Input
									value={row.name}
									placeholder={
										row.kind === "business" ? "Acme Robotics LLC" : "Personal"
									}
									onChange={(e) => update(index, { name: e.target.value })}
								/>
							</Field>
							<Field label="Short" className="max-sm:order-3">
								<Input
									value={row.shortName}
									maxLength={24}
									placeholder="ACME"
									onChange={(e) =>
										update(index, { shortName: e.target.value.toUpperCase() })
									}
								/>
							</Field>
							<Field label="Kind" className="max-sm:order-4">
								<Select
									value={row.kind}
									onChange={(e) =>
										update(index, {
											kind: e.target.value as EntityDraft["kind"],
										})
									}
								>
									<option value="personal">Personal</option>
									<option value="business">Business</option>
								</Select>
							</Field>
							<div className="flex flex-col gap-1 max-sm:order-5 max-sm:col-span-2">
								<span className="label-caps">Color</span>
								<ColorPicker
									value={row.color}
									onChange={(color) => update(index, { color })}
								/>
							</div>
							<div className="flex items-center gap-1 self-center max-sm:order-2 sm:self-end">
								<Button
									variant="ghost"
									size="sm"
									aria-label={row.isDefault ? "Default entity" : "Make default"}
									title="Default entity for new manual orders"
									onClick={() => update(index, { isDefault: true })}
								>
									{row.isDefault ? (
										<IconStarFilled className="text-amber-500" />
									) : (
										<IconStar />
									)}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									aria-label="Remove row"
									disabled={rows.length === 1}
									onClick={() =>
										setRows((current) => current.filter((_, i) => i !== index))
									}
								>
									<IconTrash />
								</Button>
							</div>
						</div>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						onClick={() =>
							setRows((current) => [
								...current,
								{
									name: "",
									shortName: "",
									kind: "business",
									color: nextColor(current.map((r) => r.color)),
									isDefault: false,
								},
							])
						}
					>
						<IconPlus /> Add business
					</Button>
					<span className="flex flex-wrap items-center gap-1">
						{valid.map((row, index) => (
							<EntityChip
								// biome-ignore lint/suspicious/noArrayIndexKey: preview
								key={index}
								entity={{ id: String(index), ...row }}
							/>
						))}
					</span>
				</div>
				<label className="flex items-start gap-2 text-xs">
					<input
						type="checkbox"
						className="mt-0.5"
						checked={withCategories}
						onChange={(e) => setWithCategories(e.target.checked)}
					/>
					<span>
						Also add shared starter categories
						<span className="block text-[11px] text-muted-foreground">
							{STARTER_CATEGORIES.join(" · ")}
						</span>
					</span>
				</label>
				<div className="flex justify-end">
					<Button
						variant="primary"
						size="md"
						disabled={valid.length === 0 || create.isPending}
						onClick={() => create.mutate()}
					>
						Create {valid.length} entit{valid.length === 1 ? "y" : "ies"}
					</Button>
				</div>
			</div>
		</section>
	);
}

/* ───────────────────────── editor ───────────────────────── */

function EntityForm({
	entity,
	onDone,
	nextSort,
	usedColors,
}: {
	entity?: EntityRow;
	onDone: () => void;
	nextSort: number;
	usedColors: string[];
}) {
	const invalidate = useInvalidateLedger();
	const [draft, setDraft] = useState<EntityDraft>(() => ({
		name: entity?.name ?? "",
		shortName: entity?.shortName ?? "",
		kind: entity?.kind ?? "business",
		color: (entity?.color as EntityColor) ?? nextColor(usedColors),
		isDefault: entity?.isDefault ?? false,
	}));
	const save = useMutation({
		mutationFn: () =>
			saveEntity({
				data: {
					id: entity?.id,
					name: draft.name.trim(),
					shortName: draft.shortName.trim() || null,
					kind: draft.kind,
					color: draft.color,
					isDefault: draft.isDefault,
					sort: entity?.sort ?? nextSort,
					archived: Boolean(entity?.archivedAt),
				},
			}),
		onSuccess: async () => {
			toast.success(entity ? "Entity updated" : "Entity created");
			await invalidate();
			onDone();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	return (
		<form
			className="space-y-3 rounded-sm border border-primary/40 bg-background/40 p-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (draft.name.trim()) save.mutate();
			}}
		>
			<div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
				<Field label="Name">
					<Input
						required
						autoFocus
						value={draft.name}
						onChange={(e) => setDraft({ ...draft, name: e.target.value })}
					/>
				</Field>
				<Field label="Short name" hint="Shown in dense tables">
					<Input
						maxLength={24}
						value={draft.shortName}
						onChange={(e) =>
							setDraft({ ...draft, shortName: e.target.value.toUpperCase() })
						}
					/>
				</Field>
				<Field label="Kind">
					<Select
						value={draft.kind}
						onChange={(e) =>
							setDraft({
								...draft,
								kind: e.target.value as EntityDraft["kind"],
							})
						}
					>
						<option value="personal">Personal</option>
						<option value="business">Business</option>
					</Select>
				</Field>
			</div>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="flex flex-col gap-1">
					<span className="label-caps">Color</span>
					<ColorPicker
						value={draft.color}
						onChange={(color) => setDraft({ ...draft, color })}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<span className="label-caps">Preview</span>
					<div className="flex items-center gap-1.5">
						<EntityChip
							entity={{
								id: "preview",
								name: draft.name || "Entity name",
								shortName: draft.shortName,
								color: draft.color,
							}}
						/>
						<EntityChip
							short
							entity={{
								id: "preview",
								name: draft.name || "Entity",
								shortName: draft.shortName,
								color: draft.color,
							}}
						/>
					</div>
				</div>
				<label className="flex items-center gap-1.5 text-xs">
					<input
						type="checkbox"
						checked={draft.isDefault}
						onChange={(e) =>
							setDraft({ ...draft, isDefault: e.target.checked })
						}
					/>
					Default entity
				</label>
			</div>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button
					type="submit"
					variant="primary"
					disabled={!draft.name.trim() || save.isPending}
				>
					{entity ? "Save entity" : "Create entity"}
				</Button>
			</div>
		</form>
	);
}

/* ───────────────────────── list ───────────────────────── */

export function EntitiesSection({
	entityOrders,
	entityConnections,
}: {
	entityOrders: Record<string, number>;
	entityConnections: Record<string, number>;
}) {
	const { data } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [editing, setEditing] = useState<string | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const all = data?.entities ?? [];
	const active = all.filter((e) => !e.archivedAt);
	const archived = all.filter((e) => e.archivedAt);

	const reorder = useMutation({
		mutationFn: (ids: string[]) => reorderEntities({ data: { ids } }),
		onSuccess: () => invalidate(),
		onError: (error) => toast.error(errorText(error)),
	});
	const archive = useMutation({
		mutationFn: (input: { entity: EntityRow; archived: boolean }) =>
			saveEntity({
				data: {
					id: input.entity.id,
					name: input.entity.name,
					shortName: input.entity.shortName,
					kind: input.entity.kind,
					color: input.entity.color,
					isDefault: input.archived ? false : input.entity.isDefault,
					sort: input.entity.sort,
					archived: input.archived,
				},
			}),
		onSuccess: async (_r, input) => {
			toast.success(
				input.archived
					? `${input.entity.name} archived — existing orders keep it`
					: `${input.entity.name} restored`,
			);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const move = (index: number, delta: number) => {
		const ids = active.map((e) => e.id);
		const target = index + delta;
		if (target < 0 || target >= ids.length) return;
		[ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
		reorder.mutate(ids);
	};

	const row = (entity: EntityRow, index: number, isArchived: boolean) =>
		editing === entity.id ? (
			<li key={entity.id} className="py-1.5">
				<EntityForm
					entity={entity}
					nextSort={entity.sort}
					usedColors={[]}
					onDone={() => setEditing(null)}
				/>
			</li>
		) : (
			<li
				key={entity.id}
				className={cn(
					"flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 py-1.5",
					isArchived && "opacity-60",
				)}
			>
				{!isArchived && (
					<span className="flex flex-col">
						<button
							type="button"
							aria-label={`Move ${entity.name} up`}
							disabled={index === 0 || reorder.isPending}
							onClick={() => move(index, -1)}
							className="text-muted-foreground hover:text-foreground disabled:opacity-30"
						>
							<IconChevronUp className="size-3" />
						</button>
						<button
							type="button"
							aria-label={`Move ${entity.name} down`}
							disabled={index === active.length - 1 || reorder.isPending}
							onClick={() => move(index, 1)}
							className="text-muted-foreground hover:text-foreground disabled:opacity-30"
						>
							<IconChevronDown className="size-3" />
						</button>
					</span>
				)}
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-2">
						<EntityChip entity={entity} />
						{entity.shortName && (
							<span className="font-mono text-[11px] text-muted-foreground">
								{entity.shortName}
							</span>
						)}
					</span>
				</span>
				<span className="flex items-center gap-1.5">
					<Tag tone="neutral">
						{entity.kind === "personal" ? (
							<IconUser className="size-3" />
						) : (
							<IconBuildingStore className="size-3" />
						)}
						{entity.kind}
					</Tag>
					{entity.isDefault && <Tag tone="primary">default</Tag>}
					{isArchived && <Tag tone="warning">archived</Tag>}
				</span>
				<span className="w-24 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
					{entityOrders[entity.id] ?? 0} orders
					{entityConnections[entity.id] ? (
						<span className="block">
							{entityConnections[entity.id]} connection
							{entityConnections[entity.id] === 1 ? "" : "s"}
						</span>
					) : null}
				</span>
				<span className="flex items-center gap-0.5">
					{!isArchived && (
						<Button
							variant="ghost"
							size="xs"
							aria-label={`Edit ${entity.name}`}
							onClick={() => setEditing(entity.id)}
						>
							<IconPencil />
						</Button>
					)}
					<Button
						variant="ghost"
						size="xs"
						aria-label={
							isArchived ? `Restore ${entity.name}` : `Archive ${entity.name}`
						}
						title={isArchived ? "Restore" : "Archive (hidden from pickers)"}
						disabled={archive.isPending}
						onClick={() => archive.mutate({ entity, archived: !isArchived })}
					>
						{isArchived ? <IconArrowBackUp /> : <IconArchive />}
					</Button>
				</span>
			</li>
		);

	return (
		<Panel
			title={`Entities · ${active.length}`}
			action={
				<div className="flex items-center gap-2">
					{archived.length > 0 && (
						<button
							type="button"
							className="text-[11px] text-muted-foreground hover:text-foreground"
							onClick={() => setShowArchived((v) => !v)}
						>
							{showArchived ? "Hide" : "Show"} archived ({archived.length})
						</button>
					)}
					<Button size="xs" onClick={() => setEditing("new")}>
						<IconPlus /> Entity
					</Button>
				</div>
			}
		>
			<div className="space-y-2">
				{editing === "new" && (
					<EntityForm
						nextSort={(active.at(-1)?.sort ?? 0) + 10}
						usedColors={active.map((e) => e.color)}
						onDone={() => setEditing(null)}
					/>
				)}
				<ul className="divide-y divide-border">
					{active.map((entity, index) => row(entity, index, false))}
					{showArchived &&
						archived.map((entity, index) => row(entity, index, true))}
				</ul>
				{active.length > 0 && !active.some((e) => e.isDefault) && (
					<Callout tone="warning" title="No default entity">
						Pick a default (edit → Default entity) so manual orders and quick
						triage have a sensible starting point.
					</Callout>
				)}
			</div>
		</Panel>
	);
}
