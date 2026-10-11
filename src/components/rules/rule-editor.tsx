import {
	IconDeviceFloppy,
	IconFlask,
	IconPlus,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDate, STORE_META } from "#/components/app/format";
import {
	Button,
	EntityChip,
	Field,
	Input,
	Money,
	Select,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { errorText, Switch } from "#/components/settings/ui";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import {
	deleteRule,
	dryRunRule,
	saveRule,
} from "#/features/ledger/ledger.functions";
import { cn } from "#/lib/utils";
import {
	type ConditionDraft,
	type ConditionField,
	condition,
	conditionErrors,
	draftToInput,
	FIELDS,
	hasActions,
	OPS,
	opsFor,
	type RuleDraft,
} from "./rule-utils";

function useDebounced<T>(value: T, delay: number) {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

function ConditionRow({
	value,
	error,
	onChange,
	onRemove,
	canRemove,
	last4Options,
}: {
	value: ConditionDraft;
	error?: string;
	onChange: (next: ConditionDraft) => void;
	onRemove: () => void;
	canRemove: boolean;
	last4Options: Array<{ last4: string; label: string }>;
}) {
	const meta = FIELDS.find((f) => f.value === value.field);
	const ops = opsFor(value.field);
	const listId = `last4-${value.key}`;
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-1.5 sm:grid-cols-[8rem_7.5rem_minmax(0,1fr)_auto]">
			<Select
				aria-label="Condition field"
				value={value.field}
				onChange={(e) => {
					const field = e.target.value as ConditionField;
					const nextOps = opsFor(field);
					onChange({
						...value,
						field,
						op: nextOps.includes(value.op)
							? value.op
							: (nextOps[0] ?? "equals"),
						value:
							field === "source"
								? "amazon"
								: field === value.field
									? value.value
									: "",
					});
				}}
			>
				{FIELDS.map((f) => (
					<option key={f.value} value={f.value}>
						{f.label}
					</option>
				))}
			</Select>
			<Select
				aria-label="Condition operator"
				value={value.op}
				onChange={(e) =>
					onChange({ ...value, op: e.target.value as ConditionDraft["op"] })
				}
			>
				{OPS.filter((o) => ops.includes(o.value)).map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</Select>
			<div className="col-span-2 flex flex-col gap-0.5 sm:col-span-1 max-sm:order-last">
				{meta?.kind === "store" ? (
					<Select
						aria-label="Store"
						value={value.value}
						onChange={(e) => onChange({ ...value, value: e.target.value })}
					>
						{Object.entries(STORE_META).map(([id, store]) => (
							<option key={id} value={id}>
								{store.label}
							</option>
						))}
					</Select>
				) : (
					<>
						<Input
							aria-label="Condition value"
							aria-invalid={Boolean(error)}
							value={value.value}
							placeholder={meta?.placeholder}
							inputMode={meta?.kind === "number" ? "decimal" : undefined}
							list={meta?.kind === "last4" ? listId : undefined}
							className={cn(error && value.value && "border-red-500/60")}
							onChange={(e) =>
								onChange({
									...value,
									value:
										meta?.kind === "currency"
											? e.target.value.toUpperCase()
											: e.target.value,
								})
							}
						/>
						{meta?.kind === "last4" && (
							<datalist id={listId}>
								{last4Options.map((o) => (
									<option key={o.last4} value={o.last4}>
										{o.label}
									</option>
								))}
							</datalist>
						)}
						{error && value.value && (
							<span className="text-[10px] text-red-600 dark:text-red-400">
								{error}
							</span>
						)}
					</>
				)}
			</div>
			<Button
				variant="ghost"
				aria-label="Remove condition"
				disabled={!canRemove}
				onClick={onRemove}
			>
				<IconX />
			</Button>
		</div>
	);
}

export function RuleEditor({
	initial,
	onClose,
	onSaved,
}: {
	initial: RuleDraft;
	onClose: () => void;
	onSaved: (id: string) => void;
}) {
	const { activeEntities, activeCategories, data, entityById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [draft, setDraft] = useState(initial);
	const set = (patch: Partial<RuleDraft>) =>
		setDraft((current) => ({ ...current, ...patch }));

	const errors = conditionErrors(draft);
	const conditionsValid = Object.keys(errors).length === 0;
	const canSave = conditionsValid && hasActions(draft) && draft.name.trim();

	const input = useMemo(() => draftToInput(draft), [draft]);
	const debounced = useDebounced(
		conditionsValid ? JSON.stringify({ ...input, enabled: true }) : null,
		400,
	);
	const dryRun = useQuery({
		queryKey: ["ledger", "rules", "dry-run", debounced],
		queryFn: () => dryRunRule({ data: JSON.parse(debounced as string) }),
		enabled: debounced != null,
		placeholderData: keepPreviousData,
		staleTime: 30_000,
	});

	const save = useMutation({
		mutationFn: () => saveRule({ data: input }),
		onSuccess: async (row) => {
			toast.success(draft.id ? "Rule saved" : "Rule created");
			await invalidate();
			if (row) onSaved(row.id);
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteRule({ data: { id } }),
		onSuccess: async () => {
			toast.success("Rule deleted");
			await invalidate();
			onClose();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const last4Options = (data?.paymentMethods ?? [])
		.filter((m) => m.last4)
		.map((m) => ({ last4: m.last4, label: m.label }));
	const updateCondition = (index: number, next: ConditionDraft) =>
		set({
			conditions: draft.conditions.map((c, i) => (i === index ? next : c)),
		});
	const categoriesForEntity = activeCategories.filter(
		(c) => !c.entityId || !draft.entityId || c.entityId === draft.entityId,
	);

	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (canSave) save.mutate();
			}}
		>
			<div className="flex items-end gap-2">
				<Field label="Rule name" className="flex-1">
					<Input
						required
						value={draft.name}
						placeholder="e.g. DigiKey → Acme"
						className="font-sans"
						onChange={(e) => set({ name: e.target.value })}
					/>
				</Field>
				<div className="flex h-6 items-center gap-1.5 text-xs">
					<Switch
						label="Rule enabled"
						checked={draft.enabled}
						onChange={(enabled) => set({ enabled })}
					/>
					<span className="hidden sm:inline">Enabled</span>
				</div>
			</div>

			<section className="space-y-1.5">
				<div className="flex flex-wrap items-center gap-1.5 text-xs">
					<span className="label-caps">When</span>
					<Select
						aria-label="Match mode"
						value={draft.match}
						onChange={(e) => set({ match: e.target.value as "all" | "any" })}
						className="w-auto"
					>
						<option value="all">all conditions match</option>
						<option value="any">any condition matches</option>
					</Select>
				</div>
				{draft.conditions.map((c, index) => (
					<ConditionRow
						key={c.key}
						value={c}
						error={errors[c.key]}
						canRemove={draft.conditions.length > 1}
						last4Options={last4Options}
						onChange={(next) => updateCondition(index, next)}
						onRemove={() =>
							set({
								conditions: draft.conditions.filter((_, i) => i !== index),
							})
						}
					/>
				))}
				<Button
					size="xs"
					variant="ghost"
					disabled={draft.conditions.length >= 20}
					onClick={() =>
						set({ conditions: [...draft.conditions, condition("merchant")] })
					}
				>
					<IconPlus /> Condition
				</Button>
			</section>

			<section className="space-y-1.5">
				<span className="label-caps">Then</span>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					<Field label="Assign entity">
						<Select
							value={draft.entityId}
							onChange={(e) => set({ entityId: e.target.value })}
						>
							<option value="">— unchanged —</option>
							{activeEntities.map((entity) => (
								<option key={entity.id} value={entity.id}>
									{entity.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label="Category">
						<Select
							value={draft.categoryId}
							onChange={(e) => set({ categoryId: e.target.value })}
						>
							<option value="">— unchanged —</option>
							{categoriesForEntity.map((category) => (
								<option key={category.id} value={category.id}>
									{category.code ? `${category.code} · ` : ""}
									{category.name}
								</option>
							))}
						</Select>
					</Field>
					<Field label="Reimbursable">
						<Select
							value={draft.reimbursable}
							onChange={(e) =>
								set({
									reimbursable: e.target.value as RuleDraft["reimbursable"],
								})
							}
						>
							<option value="">— unchanged —</option>
							<option value="auto">Auto (payer ≠ entity)</option>
							<option value="yes">Always reimbursable</option>
							<option value="no">Never reimbursable</option>
						</Select>
					</Field>
					<Field label="Auto-file">
						<Select
							value={draft.file}
							onChange={(e) =>
								set({ file: e.target.value as RuleDraft["file"] })
							}
						>
							<option value="">— unchanged —</option>
							<option value="yes">File (skip inbox)</option>
							<option value="no">Keep in inbox</option>
						</Select>
					</Field>
					<Field label="Tags" hint="Comma separated" className="col-span-2">
						<Input
							value={draft.tags}
							placeholder="review, lab"
							onChange={(e) => set({ tags: e.target.value })}
						/>
					</Field>
				</div>
				{!hasActions(draft) && (
					<p className="text-[11px] text-amber-600 dark:text-amber-400">
						Pick at least one action.
					</p>
				)}
				<p className="text-[11px] text-muted-foreground">
					Rules run by priority on new orders; the first rule to set each action
					wins, tags accumulate.
				</p>
			</section>

			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
				<div>
					{draft.id && (
						<Button
							variant="danger"
							disabled={remove.isPending}
							onClick={() => {
								if (window.confirm(`Delete rule “${draft.name}”?`))
									remove.mutate(draft.id as string);
							}}
						>
							<IconTrash /> Delete
						</Button>
					)}
				</div>
				<div className="flex gap-2">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="primary"
						disabled={!canSave || save.isPending}
					>
						<IconDeviceFloppy /> {draft.id ? "Save rule" : "Create rule"}
					</Button>
				</div>
			</div>

			<section className="rounded-sm border border-border bg-background/40">
				<header className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
					<span className="label-caps flex items-center gap-1">
						<IconFlask className="size-3" /> Dry run
					</span>
					<span className="font-mono text-[11px] text-muted-foreground">
						{!conditionsValid
							? "fix conditions to preview"
							: dryRun.isFetching
								? "checking…"
								: dryRun.data
									? `${dryRun.data.matchCount} of ${dryRun.data.scanned} recent orders`
									: ""}
					</span>
				</header>
				{dryRun.isError ? (
					<p className="p-2 text-[11px] text-red-600 dark:text-red-400">
						{errorText(dryRun.error)}
					</p>
				) : dryRun.data && dryRun.data.matches.length > 0 ? (
					<ul
						className={cn(
							"max-h-72 divide-y divide-border overflow-auto",
							dryRun.isFetching && "opacity-60",
						)}
					>
						{dryRun.data.matches.map((order) => (
							<li key={order.id}>
								<Link
									to="/app/orders/$orderId"
									params={{ orderId: order.id }}
									className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-2 px-2 py-1 text-xs hover:bg-accent/50"
								>
									<StoreMark
										source={order.source}
										className="text-[10px] [&>span:last-child]:hidden"
									/>
									<span className="min-w-0">
										<span className="block truncate">
											{order.merchantName || order.externalOrderId}
										</span>
										<span className="block truncate font-mono text-[10px] text-muted-foreground">
											{order.externalOrderId} · {formatDate(order.orderDate)}
										</span>
									</span>
									<Money minor={order.totalMinor} currency={order.currency} />
								</Link>
							</li>
						))}
					</ul>
				) : (
					<p className="p-3 text-center text-[11px] text-muted-foreground">
						{dryRun.data
							? "No recent orders match."
							: "Start typing a condition."}
					</p>
				)}
				{dryRun.data && dryRun.data.matchCount > dryRun.data.matches.length && (
					<p className="border-t border-border px-2 py-1 text-[10px] text-muted-foreground">
						Showing first {dryRun.data.matches.length}.
					</p>
				)}
				{draft.entityId && dryRun.data && dryRun.data.matchCount > 0 && (
					<p className="flex items-center gap-1 border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
						Would assign{" "}
						<EntityChip short entity={entityById.get(draft.entityId)} />
						{draft.file === "yes" && <Tag tone="success">filed</Tag>}
					</p>
				)}
			</section>
		</form>
	);
}
