/** Budget list with progress bars and an inline editor. */
import {
	IconPencil,
	IconPigMoney,
	IconPlus,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ENTITY_STYLES, formatMoney } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Field,
	Input,
	Panel,
	Select,
	StatTile,
	Tag,
} from "#/components/app/primitives";
import { errorText, Switch } from "#/components/settings/ui";
import {
	deleteBudget,
	listBudgets,
	saveBudget,
} from "#/features/automation/automation.functions";
import { BUDGET_PERIOD_OPTIONS } from "#/features/automation/inputs";
import { useBootstrap } from "#/features/ledger/hooks";
import { cn } from "#/lib/utils";
import { automationKeys } from "./notification-settings";

type Budget = Awaited<ReturnType<typeof listBudgets>>[number];
type Draft = {
	id?: string;
	entityId: string;
	categoryId: string | null;
	period: (typeof BUDGET_PERIOD_OPTIONS)[number];
	amount: string;
	currency: string;
	thresholdPct: number;
	enabled: boolean;
};

const LEVEL_TONE = {
	ok: "success",
	threshold: "warning",
	exceeded: "danger",
} as const;

export function BudgetsView() {
	const client = useQueryClient();
	const { activeEntities, activeCategories, entityById } = useBootstrap();
	const query = useQuery({
		queryKey: automationKeys.budgets,
		queryFn: () => listBudgets(),
	});
	const [draft, setDraft] = useState<Draft | null>(null);
	const invalidate = () =>
		client.invalidateQueries({ queryKey: automationKeys.budgets });
	const save = useMutation({
		mutationFn: (value: Draft) => {
			const amountMinor = Math.round(Number.parseFloat(value.amount) * 100);
			if (!Number.isFinite(amountMinor) || amountMinor <= 0)
				throw new Error("Enter a positive amount");
			return saveBudget({
				data: {
					id: value.id,
					entityId: value.entityId,
					categoryId: value.categoryId,
					period: value.period,
					amountMinor,
					currency: value.currency,
					thresholdPct: value.thresholdPct,
					enabled: value.enabled,
				},
			});
		},
		onSuccess: () => {
			setDraft(null);
			toast.success("Budget saved");
			void invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const remove = useMutation({
		mutationFn: (id: string) => deleteBudget({ data: { id } }),
		onSuccess: () => void invalidate(),
		onError: (error) => toast.error(errorText(error)),
	});
	const budgets = query.data ?? [];
	const counts = {
		over: budgets.filter((b) => b.level === "exceeded").length,
		near: budgets.filter((b) => b.level === "threshold").length,
	};
	const newDraft = (): Draft => ({
		entityId: activeEntities[0]?.id ?? "",
		categoryId: null,
		period: "month",
		amount: "",
		currency: "USD",
		thresholdPct: 80,
		enabled: true,
	});

	return (
		<div className="flex flex-col gap-4 p-4">
			<div className="grid grid-cols-3 gap-2 sm:max-w-xl">
				<StatTile label="Budgets" value={budgets.length} />
				<StatTile
					label="Near limit"
					value={counts.near}
					tone={counts.near ? "warning" : undefined}
				/>
				<StatTile
					label="Over"
					value={counts.over}
					tone={counts.over ? "danger" : undefined}
				/>
			</div>
			<Panel
				title="Budgets"
				action={
					<Button
						size="xs"
						onClick={() => setDraft(newDraft())}
						disabled={activeEntities.length === 0}
					>
						<IconPlus /> Budget
					</Button>
				}
				bodyClassName="flex flex-col gap-3"
			>
				{draft && (
					<BudgetForm
						draft={draft}
						onChange={setDraft}
						onCancel={() => setDraft(null)}
						onSave={() => save.mutate(draft)}
						saving={save.isPending}
						entities={activeEntities}
						categories={activeCategories}
					/>
				)}
				{budgets.length === 0 && !draft ? (
					<EmptyState icon={<IconPigMoney />} title="No budgets yet">
						Set a monthly, quarterly or yearly limit per entity (optionally per
						category). You are alerted when spend crosses the threshold and
						again when it is exceeded.
					</EmptyState>
				) : (
					<ul className="flex flex-col gap-2">
						{budgets.map((budget) => (
							<BudgetRow
								key={budget.id}
								budget={budget}
								color={
									entityById.get(budget.entityId)?.color ?? budget.entityColor
								}
								onEdit={() =>
									setDraft({
										id: budget.id,
										entityId: budget.entityId,
										categoryId: budget.categoryId,
										period: budget.period,
										amount: (budget.amountMinor / 100).toFixed(2),
										currency: budget.currency,
										thresholdPct: budget.thresholdPct,
										enabled: budget.enabled,
									})
								}
								onDelete={() => {
									if (confirm("Delete this budget?")) remove.mutate(budget.id);
								}}
							/>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

function BudgetRow({
	budget,
	color,
	onEdit,
	onDelete,
}: {
	budget: Budget;
	color: string;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const width = Math.min(100, budget.pct);
	const thresholdLeft = Math.min(100, budget.thresholdPct);
	return (
		<li
			className={cn(
				"rounded-sm border border-border px-3 py-2",
				!budget.enabled && "opacity-60",
			)}
		>
			<div className="flex flex-wrap items-center gap-2 text-xs">
				<EntityChip
					entity={{ id: budget.entityId, name: budget.entityName, color }}
				/>
				{budget.categoryName && <Tag>{budget.categoryName}</Tag>}
				<span className="text-muted-foreground">
					{budget.period} · {budget.periodKey}
				</span>
				<Tag tone={LEVEL_TONE[budget.level]}>
					{budget.level === "ok" ? "on track" : budget.level}
				</Tag>
				{!budget.enabled && <Tag>paused</Tag>}
				<span className="ml-auto font-mono tabular-nums">
					{formatMoney(budget.spentMinor, budget.currency)} /{" "}
					{formatMoney(budget.amountMinor, budget.currency)}{" "}
					<span className="text-muted-foreground">({budget.pct}%)</span>
				</span>
				<Button size="xs" variant="ghost" title="Edit" onClick={onEdit}>
					<IconPencil />
				</Button>
				<Button size="xs" variant="ghost" title="Delete" onClick={onDelete}>
					<IconTrash />
				</Button>
			</div>
			<div
				className="relative mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(width)}
				aria-label={`${budget.entityName} budget used`}
			>
				<div
					className={cn(
						"h-full rounded-full",
						budget.level === "exceeded"
							? "bg-red-500"
							: budget.level === "threshold"
								? "bg-amber-500"
								: (ENTITY_STYLES[color]?.bar ?? "bg-sky-400"),
					)}
					style={{ width: `${width}%` }}
				/>
				<div
					className="absolute top-0 h-full w-px bg-foreground/40"
					style={{ left: `${thresholdLeft}%` }}
					title={`Alert at ${budget.thresholdPct}%`}
				/>
			</div>
		</li>
	);
}

function BudgetForm({
	draft,
	onChange,
	onCancel,
	onSave,
	saving,
	entities,
	categories,
}: {
	draft: Draft;
	onChange: (draft: Draft) => void;
	onCancel: () => void;
	onSave: () => void;
	saving: boolean;
	entities: Array<{ id: string; name: string }>;
	categories: Array<{ id: string; name: string; entityId: string | null }>;
}) {
	const usable = categories.filter(
		(c) => !c.entityId || c.entityId === draft.entityId,
	);
	return (
		<div className="flex flex-col gap-2 rounded-sm border border-border bg-muted/30 p-2.5">
			<div className="grid gap-2 sm:grid-cols-3">
				<Field label="Entity">
					<Select
						value={draft.entityId}
						onChange={(e) =>
							onChange({ ...draft, entityId: e.target.value, categoryId: null })
						}
					>
						{entities.map((entity) => (
							<option key={entity.id} value={entity.id}>
								{entity.name}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Category">
					<Select
						value={draft.categoryId ?? ""}
						onChange={(e) =>
							onChange({ ...draft, categoryId: e.target.value || null })
						}
					>
						<option value="">All categories</option>
						{usable.map((category) => (
							<option key={category.id} value={category.id}>
								{category.name}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Period">
					<Select
						value={draft.period}
						onChange={(e) =>
							onChange({ ...draft, period: e.target.value as Draft["period"] })
						}
					>
						{BUDGET_PERIOD_OPTIONS.map((period) => (
							<option key={period} value={period}>
								{period}
							</option>
						))}
					</Select>
				</Field>
				<Field label="Amount">
					<Input
						inputMode="decimal"
						value={draft.amount}
						onChange={(e) => onChange({ ...draft, amount: e.target.value })}
						placeholder="500.00"
					/>
				</Field>
				<Field label="Currency" hint="Only allocations in this currency count.">
					<Input
						maxLength={3}
						value={draft.currency}
						onChange={(e) =>
							onChange({ ...draft, currency: e.target.value.toUpperCase() })
						}
					/>
				</Field>
				<Field label="Alert at %">
					<Input
						type="number"
						min={1}
						max={100}
						value={draft.thresholdPct}
						onChange={(e) =>
							onChange({ ...draft, thresholdPct: Number(e.target.value) })
						}
					/>
				</Field>
			</div>
			<div className="flex items-center gap-2 text-xs">
				<Switch
					checked={draft.enabled}
					onChange={(enabled) => onChange({ ...draft, enabled })}
					label="Enabled"
				/>
				Enabled
				<div className="ml-auto flex gap-1">
					<Button size="sm" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="primary"
						onClick={onSave}
						disabled={saving || !draft.entityId}
					>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}
