import {
	IconArchive,
	IconArrowBackUp,
	IconCheck,
	IconPencil,
	IconPlus,
	IconX,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
	Button,
	EntityChip,
	Input,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import {
	type CategoryRow,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import { saveCategory } from "#/features/ledger/ledger.functions";
import { cn } from "#/lib/utils";
import { errorText } from "./ui";

type Draft = { name: string; code: string; entityId: string };

function CategoryEditor({
	initial,
	submitLabel,
	onSubmit,
	onCancel,
	pending,
}: {
	initial: Draft;
	submitLabel: string;
	onSubmit: (draft: Draft) => void;
	onCancel?: () => void;
	pending: boolean;
}) {
	const { activeEntities } = useBootstrap();
	const [draft, setDraft] = useState(initial);
	return (
		<form
			className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-1.5 sm:grid-cols-[minmax(0,1fr)_6rem_10rem_auto]"
			onSubmit={(e) => {
				e.preventDefault();
				if (!draft.name.trim()) return;
				onSubmit(draft);
				if (!onCancel)
					setDraft({ name: "", code: "", entityId: draft.entityId });
			}}
		>
			<Input
				aria-label="Category name"
				placeholder="Category name"
				value={draft.name}
				onChange={(e) => setDraft({ ...draft, name: e.target.value })}
			/>
			<Input
				aria-label="GL code"
				placeholder="GL code"
				maxLength={40}
				value={draft.code}
				onChange={(e) => setDraft({ ...draft, code: e.target.value })}
			/>
			<Select
				aria-label="Entity scope"
				value={draft.entityId}
				onChange={(e) => setDraft({ ...draft, entityId: e.target.value })}
			>
				<option value="">Shared (all entities)</option>
				{activeEntities.map((entity) => (
					<option key={entity.id} value={entity.id}>
						Only {entity.name}
					</option>
				))}
			</Select>
			<div className="flex gap-1 max-sm:col-span-2 max-sm:justify-end">
				<Button
					type="submit"
					variant={onCancel ? "primary" : "secondary"}
					disabled={!draft.name.trim() || pending}
					aria-label={submitLabel}
				>
					{onCancel ? <IconCheck /> : <IconPlus />}
					{submitLabel}
				</Button>
				{onCancel && (
					<Button variant="ghost" aria-label="Cancel" onClick={onCancel}>
						<IconX />
					</Button>
				)}
			</div>
		</form>
	);
}

export function CategoriesSection({
	categoryUses,
}: {
	categoryUses: Record<string, number>;
}) {
	const { data, entityById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [editing, setEditing] = useState<string | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const [filter, setFilter] = useState("");
	const all = data?.categories ?? [];
	const archivedCount = all.filter((c) => c.archivedAt).length;
	const needle = filter.trim().toLowerCase();
	const visible = all.filter(
		(c) =>
			(showArchived || !c.archivedAt) &&
			(!needle ||
				c.name.toLowerCase().includes(needle) ||
				(c.code ?? "").toLowerCase().includes(needle)),
	);

	const save = useMutation({
		mutationFn: (input: { id?: string; draft: Draft; archived?: boolean }) =>
			saveCategory({
				data: {
					id: input.id,
					name: input.draft.name.trim(),
					code: input.draft.code.trim() || null,
					entityId: input.draft.entityId || null,
					archived: input.archived ?? false,
				},
			}),
		onSuccess: async (_r, input) => {
			toast.success(
				input.archived
					? `Archived ${input.draft.name}`
					: input.id
						? "Category saved"
						: `Added ${input.draft.name}`,
			);
			setEditing(null);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const toDraft = (c: CategoryRow): Draft => ({
		name: c.name,
		code: c.code ?? "",
		entityId: c.entityId ?? "",
	});

	return (
		<Panel
			title={`Categories · ${all.length - archivedCount}`}
			action={
				archivedCount > 0 ? (
					<button
						type="button"
						className="text-[11px] text-muted-foreground hover:text-foreground"
						onClick={() => setShowArchived((v) => !v)}
					>
						{showArchived ? "Hide" : "Show"} archived ({archivedCount})
					</button>
				) : undefined
			}
		>
			<div className="space-y-2">
				<p className="text-[11px] text-muted-foreground">
					Categories classify spend and map to accounts in your bookkeeping (see
					Connections). The optional GL code is shown in exports; scope a
					category to one entity to hide it elsewhere.
				</p>
				<CategoryEditor
					initial={{ name: "", code: "", entityId: "" }}
					submitLabel="Add"
					pending={save.isPending}
					onSubmit={(draft) => save.mutate({ draft })}
				/>
				{all.length > 8 && (
					<Input
						aria-label="Filter categories"
						placeholder="Filter…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="max-w-56"
					/>
				)}
				{visible.length === 0 ? (
					<p className="py-4 text-center text-xs text-muted-foreground">
						{all.length === 0 ? "No categories yet." : "No matches."}
					</p>
				) : (
					<ul className="divide-y divide-border border-t border-border">
						{visible.map((category) =>
							editing === category.id ? (
								<li key={category.id} className="py-1.5">
									<CategoryEditor
										initial={toDraft(category)}
										submitLabel="Save"
										pending={save.isPending}
										onCancel={() => setEditing(null)}
										onSubmit={(draft) =>
											save.mutate({ id: category.id, draft })
										}
									/>
								</li>
							) : (
								<li
									key={category.id}
									className={cn(
										"flex min-h-7 items-center gap-2 py-1 text-xs",
										category.archivedAt && "opacity-60",
									)}
								>
									<span className="w-14 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
										{category.code || "—"}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{category.name}
									</span>
									{category.entityId ? (
										<EntityChip
											short
											entity={entityById.get(category.entityId)}
										/>
									) : (
										<span className="hidden text-[11px] text-muted-foreground sm:inline">
											shared
										</span>
									)}
									{category.archivedAt && <Tag tone="warning">archived</Tag>}
									<span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
										{categoryUses[category.id] ?? 0}
									</span>
									<span className="flex">
										{!category.archivedAt && (
											<Button
												variant="ghost"
												size="xs"
												aria-label={`Edit ${category.name}`}
												onClick={() => setEditing(category.id)}
											>
												<IconPencil />
											</Button>
										)}
										<Button
											variant="ghost"
											size="xs"
											aria-label={
												category.archivedAt
													? `Restore ${category.name}`
													: `Archive ${category.name}`
											}
											disabled={save.isPending}
											onClick={() =>
												save.mutate({
													id: category.id,
													draft: toDraft(category),
													archived: !category.archivedAt,
												})
											}
										>
											{category.archivedAt ? (
												<IconArrowBackUp />
											) : (
												<IconArchive />
											)}
										</Button>
									</span>
								</li>
							),
						)}
					</ul>
				)}
			</div>
		</Panel>
	);
}
