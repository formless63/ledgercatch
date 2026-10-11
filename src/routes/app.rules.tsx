import {
	IconAdjustmentsBolt,
	IconChevronDown,
	IconChevronUp,
	IconPlayerPlay,
	IconPlus,
	IconTemplate,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatRelative, storeLabel } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	PageHeader,
	Panel,
	Tag,
} from "#/components/app/primitives";
import { RuleEditor } from "#/components/rules/rule-editor";
import { RuleSuggestions } from "#/components/rules/rule-suggestions";
import {
	describeConditions,
	draftFromRule,
	emptyDraft,
	type RuleDraft,
	type RuleRow,
	TEMPLATES,
} from "#/components/rules/rule-utils";
import { errorText, Switch } from "#/components/settings/ui";
import {
	ledgerKeys,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import { listRules, runRulesOnInbox } from "#/features/ledger/ledger.functions";
import {
	reorderRules,
	setRuleEnabled,
} from "#/features/ledger/settings-ui.functions";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/app/rules")({
	component: RulesPage,
});

type Editing = { key: string; draft: RuleDraft } | null;

function ActionSummary({ rule }: { rule: RuleRow }) {
	const { entityById, categoryById } = useBootstrap();
	const a = rule.actions;
	return (
		<span className="flex flex-wrap items-center gap-1">
			{a.entityId && <EntityChip short entity={entityById.get(a.entityId)} />}
			{a.categoryId && (
				<Tag tone="neutral">
					{categoryById.get(a.categoryId)?.name ?? "category"}
				</Tag>
			)}
			{a.reimbursable && (
				<Tag tone={a.reimbursable === "yes" ? "warning" : "neutral"}>
					reimb {a.reimbursable}
				</Tag>
			)}
			{a.file !== undefined && (
				<Tag tone={a.file ? "success" : "info"}>
					{a.file ? "auto-file" : "keep in inbox"}
				</Tag>
			)}
			{a.tags?.map((tag) => (
				<Tag key={tag} tone="primary">
					#{tag}
				</Tag>
			))}
		</span>
	);
}

function RulesPage() {
	const client = useQueryClient();
	const invalidate = useInvalidateLedger();
	const rules = useQuery({
		queryKey: ledgerKeys.rules,
		queryFn: () => listRules(),
	});
	const [editing, setEditing] = useState<Editing>(null);
	const editorRef = useRef<HTMLDivElement>(null);
	const editingKey = editing?.key;
	useEffect(() => {
		if (editingKey && window.innerWidth < 1280)
			editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
	}, [editingKey]);
	const rows = rules.data ?? [];
	const nextPriority = (rows.at(-1)?.priority ?? 0) + 10;
	const topPriority = Math.max(0, (rows[0]?.priority ?? 10) - 10);

	const reorder = useMutation({
		mutationFn: (ids: string[]) => reorderRules({ data: { ids } }),
		onMutate: (ids) => {
			const previous = client.getQueryData<RuleRow[]>(ledgerKeys.rules);
			if (previous) {
				const byId = new Map(previous.map((r) => [r.id, r]));
				client.setQueryData(
					ledgerKeys.rules,
					ids.flatMap((id, index) => {
						const rule = byId.get(id);
						return rule ? [{ ...rule, priority: (index + 1) * 10 }] : [];
					}),
				);
			}
			return { previous };
		},
		onError: (error, _ids, context) => {
			if (context?.previous)
				client.setQueryData(ledgerKeys.rules, context.previous);
			toast.error(errorText(error));
		},
		onSettled: () => invalidate(),
	});
	const toggle = useMutation({
		mutationFn: (input: { id: string; enabled: boolean }) =>
			setRuleEnabled({ data: input }),
		onSuccess: () => invalidate(),
		onError: (error) => toast.error(errorText(error)),
	});
	const apply = useMutation({
		mutationFn: () => runRulesOnInbox(),
		onSuccess: async (result) => {
			toast.success(
				result.changed
					? `Rules updated ${result.changed} inbox order${result.changed === 1 ? "" : "s"}`
					: "No inbox orders changed",
			);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const move = (index: number, delta: number) => {
		const ids = rows.map((r) => r.id);
		const target = index + delta;
		if (target < 0 || target >= ids.length) return;
		[ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
		reorder.mutate(ids);
	};

	const openNew = (draft: RuleDraft) =>
		setEditing({ key: `new-${Date.now()}`, draft });

	const templates = (
		<div className="grid gap-1.5 sm:grid-cols-2">
			{TEMPLATES.map((template) => (
				<button
					key={template.id}
					type="button"
					onClick={() =>
						openNew(
							template.build(
								template.id === "large" ? topPriority : nextPriority,
							),
						)
					}
					className="rounded-sm border border-border bg-background/40 px-2.5 py-2 text-left hover:border-primary/50 hover:bg-accent/40"
				>
					<span className="block text-xs font-medium">{template.label}</span>
					<span className="block text-[11px] text-muted-foreground">
						{template.description}
					</span>
				</button>
			))}
		</div>
	);

	return (
		<div className="pb-10">
			<PageHeader
				title="Rules"
				description="Auto-assign entity, category, reimbursement and filing for new orders."
				actions={
					<>
						<Button
							disabled={apply.isPending || rows.length === 0}
							onClick={() => apply.mutate()}
						>
							<IconPlayerPlay />
							{apply.isPending ? "Applying…" : "Apply rules to inbox now"}
						</Button>
						<Button
							variant="primary"
							onClick={() => openNew(emptyDraft(nextPriority))}
						>
							<IconPlus /> New rule
						</Button>
					</>
				}
			/>
			<div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]">
				<div className="min-w-0 space-y-3">
					<RuleSuggestions />
					{rules.isLoading ? (
						<p className="py-8 text-center text-xs text-muted-foreground">
							Loading rules…
						</p>
					) : rules.isError ? (
						<p className="text-xs text-red-600 dark:text-red-400">
							{errorText(rules.error)}
						</p>
					) : rows.length === 0 ? (
						<EmptyState
							icon={<IconAdjustmentsBolt className="size-6" />}
							title="No rules yet"
						>
							Rules triage orders the moment they're captured. Start from a
							template:
							<div className="mt-3 text-left">{templates}</div>
						</EmptyState>
					) : (
						<Panel
							title={`${rows.length} rules · by priority`}
							bodyClassName="p-0"
						>
							<ol className="divide-y divide-border">
								{rows.map((rule, index) => {
									const active = editing?.draft.id === rule.id;
									return (
										<li
											key={rule.id}
											className={cn(
												"grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-2 py-2",
												active && "bg-accent/50",
												!rule.enabled && "opacity-60",
											)}
										>
											<span className="flex flex-col items-center">
												<button
													type="button"
													aria-label={`Raise priority of ${rule.name}`}
													disabled={index === 0 || reorder.isPending}
													onClick={() => move(index, -1)}
													className="text-muted-foreground hover:text-foreground disabled:opacity-30"
												>
													<IconChevronUp className="size-3.5" />
												</button>
												<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
													{index + 1}
												</span>
												<button
													type="button"
													aria-label={`Lower priority of ${rule.name}`}
													disabled={
														index === rows.length - 1 || reorder.isPending
													}
													onClick={() => move(index, 1)}
													className="text-muted-foreground hover:text-foreground disabled:opacity-30"
												>
													<IconChevronDown className="size-3.5" />
												</button>
											</span>
											<button
												type="button"
												className="min-w-0 space-y-1 text-left"
												onClick={() =>
													setEditing({
														key: rule.id,
														draft: draftFromRule(rule),
													})
												}
											>
												<span className="block truncate text-[13px] font-medium hover:text-primary">
													{rule.name}
												</span>
												<span className="block break-words font-mono text-[11px] text-muted-foreground">
													{describeConditions(rule, storeLabel)}
												</span>
												<ActionSummary rule={rule} />
											</button>
											<span className="flex flex-col items-end gap-1">
												<Switch
													label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
													checked={rule.enabled}
													disabled={toggle.isPending}
													onChange={(enabled) =>
														toggle.mutate({ id: rule.id, enabled })
													}
												/>
												<span
													className="font-mono text-[10px] tabular-nums text-muted-foreground"
													title="Times this rule contributed an action"
												>
													{rule.matchCount}×
												</span>
												<span className="whitespace-nowrap font-mono text-[10px] text-muted-foreground">
													{rule.lastMatchedAt
														? formatRelative(rule.lastMatchedAt)
														: "never"}
												</span>
											</span>
										</li>
									);
								})}
							</ol>
						</Panel>
					)}
					{rows.length > 0 && (
						<Panel
							title={
								<span className="flex items-center gap-1">
									<IconTemplate className="size-3" /> Templates
								</span>
							}
						>
							{templates}
						</Panel>
					)}
				</div>
				<div ref={editorRef} className="min-w-0 scroll-mt-2">
					{editing ? (
						<Panel
							title={editing.draft.id ? "Edit rule" : "New rule"}
							className="xl:sticky xl:top-4"
						>
							<RuleEditor
								key={editing.key}
								initial={editing.draft}
								onClose={() => setEditing(null)}
								onSaved={() => setEditing(null)}
							/>
						</Panel>
					) : (
						<div className="hidden rounded border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground xl:block">
							Select a rule to edit, or create one. The editor previews matching
							recent orders as you type.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
