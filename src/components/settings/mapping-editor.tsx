import {
	IconAlertTriangle,
	IconDeviceFloppy,
	IconRefresh,
	IconWand,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	Button,
	EntityDot,
	Field,
	Select,
	Tag,
} from "#/components/app/primitives";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import {
	getConnectionOptions,
	saveConnection,
} from "#/features/ledger/ledger.functions";
import { cn } from "#/lib/utils";
import { type ConnectionRow, cleanConfig } from "./connection-form";
import { Callout, errorText } from "./ui";

type Option = { id: string; label: string; hint?: string };

function asMap(value: unknown): Record<string, string> {
	return value && typeof value === "object"
		? Object.fromEntries(
				Object.entries(value as Record<string, unknown>).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			)
		: {};
}

function AccountSelect({
	value,
	options,
	onChange,
	label,
	emptyLabel,
}: {
	value: string;
	options: Option[];
	onChange: (value: string) => void;
	label: string;
	emptyLabel: string;
}) {
	const missing = value && !options.some((o) => o.id === value);
	return (
		<Select
			aria-label={label}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			className={cn(missing && "border-red-500/60")}
		>
			<option value="">{emptyLabel}</option>
			{missing && <option value={value}>⚠ missing remote id {value}</option>}
			{options.map((option) => (
				<option key={option.id} value={option.id}>
					{option.label}
					{option.hint ? ` — ${option.hint}` : ""}
				</option>
			))}
		</Select>
	);
}

const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

export function MappingEditor({ connection }: { connection: ConnectionRow }) {
	const { data, activeCategories, entityById } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const options = useQuery({
		queryKey: ["connector-options", connection.id],
		queryFn: () => getConnectionOptions({ data: { id: connection.id } }),
		retry: false,
		staleTime: 5 * 60_000,
	});
	const [categoryMap, setCategoryMap] = useState(() =>
		asMap(connection.config.categoryAccountMap),
	);
	const [paymentMap, setPaymentMap] = useState(() =>
		asMap(connection.config.paymentAccountMap),
	);
	const [defaultExpense, setDefaultExpense] = useState(
		typeof connection.config.defaultExpenseAccountId === "string"
			? connection.config.defaultExpenseAccountId
			: "",
	);
	const [defaultPayment, setDefaultPayment] = useState(
		typeof connection.config.defaultPaymentAccountId === "string"
			? connection.config.defaultPaymentAccountId
			: "",
	);
	const [dirty, setDirty] = useState(false);

	const categories = activeCategories.filter(
		(c) => !c.entityId || c.entityId === connection.entityId,
	);
	const methods = useMemo(
		() =>
			(data?.paymentMethods ?? [])
				.filter((m) => !m.archivedAt)
				.sort(
					(a, b) =>
						Number(b.payingEntityId === connection.entityId) -
						Number(a.payingEntityId === connection.entityId),
				),
		[data?.paymentMethods, connection.entityId],
	);
	const expenseAccounts = options.data?.expenseAccounts ?? [];
	const paymentAccounts = options.data?.paymentAccounts ?? [];

	const save = useMutation({
		mutationFn: () =>
			saveConnection({
				data: {
					id: connection.id,
					provider: connection.provider,
					name: connection.name,
					entityId: connection.entityId,
					enabled: connection.enabled,
					config: cleanConfig({
						...connection.config,
						categoryAccountMap: cleanConfig(categoryMap),
						paymentAccountMap: cleanConfig(paymentMap),
						defaultExpenseAccountId: defaultExpense,
						defaultPaymentAccountId: defaultPayment,
					}),
				},
			}),
		onSuccess: async () => {
			toast.success("Mappings saved");
			setDirty(false);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	const autoMatch = () => {
		let matched = 0;
		const next = { ...categoryMap };
		for (const category of categories) {
			if (next[category.id]) continue;
			const name = norm(category.name);
			const code = category.code?.trim();
			const hit =
				(code &&
					expenseAccounts.find(
						(a) => a.id === code || a.label.split(/\s+/)[0] === code,
					)) ||
				expenseAccounts.find((a) => norm(a.label) === name) ||
				expenseAccounts.find((a) => norm(a.label).includes(name));
			if (hit) {
				next[category.id] = hit.id;
				matched++;
			}
		}
		setCategoryMap(next);
		if (matched) setDirty(true);
		toast(
			matched
				? `Matched ${matched} categor${matched === 1 ? "y" : "ies"} by name/code — review and save`
				: "No confident name matches",
		);
	};

	const mappedCategories = categories.filter((c) => categoryMap[c.id]).length;
	const mappedMethods = methods.filter((m) => paymentMap[m.id]).length;

	if (options.isLoading)
		return (
			<p className="py-4 text-center text-xs text-muted-foreground">
				Loading remote accounts…
			</p>
		);
	if (options.isError)
		return (
			<Callout
				tone="danger"
				icon={<IconAlertTriangle />}
				title="Could not load remote options"
			>
				<p>{errorText(options.error)}</p>
				<Button size="xs" onClick={() => void options.refetch()}>
					<IconRefresh /> Retry
				</Button>
			</Callout>
		);

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-mono text-[11px] text-muted-foreground">
					{expenseAccounts.length} expense · {paymentAccounts.length} payment
					accounts
					{options.data?.vendors
						? ` · ${options.data.vendors.length} vendors`
						: ""}
				</span>
				<span className="flex gap-1">
					<Button
						size="xs"
						variant="ghost"
						disabled={options.isFetching}
						onClick={() => void options.refetch()}
					>
						<IconRefresh /> Reload
					</Button>
					<Button size="xs" onClick={autoMatch}>
						<IconWand /> Auto-match
					</Button>
				</span>
			</div>

			<div className="grid gap-2 sm:grid-cols-2">
				<Field
					label="Default expense account"
					hint="Used when an order's category isn't mapped."
				>
					<AccountSelect
						label="Default expense account"
						value={defaultExpense}
						options={expenseAccounts}
						emptyLabel="— none (unmapped exports fail) —"
						onChange={(v) => {
							setDefaultExpense(v);
							setDirty(true);
						}}
					/>
				</Field>
				<Field
					label="Default payment account"
					hint="Used when the card isn't mapped."
				>
					<AccountSelect
						label="Default payment account"
						value={defaultPayment}
						options={paymentAccounts}
						emptyLabel="— none —"
						onChange={(v) => {
							setDefaultPayment(v);
							setDirty(true);
						}}
					/>
				</Field>
			</div>

			<section>
				<div className="mb-1 flex items-center justify-between">
					<h3 className="label-caps">Categories → expense accounts</h3>
					<Tag
						tone={
							mappedCategories === categories.length ? "success" : "warning"
						}
					>
						{mappedCategories}/{categories.length}
					</Tag>
				</div>
				{categories.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">
						No categories for this entity yet.
					</p>
				) : (
					<ul className="divide-y divide-border rounded-sm border border-border">
						{categories.map((category) => (
							<li
								key={category.id}
								className="grid items-center gap-1 px-2 py-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"
							>
								<span className="flex min-w-0 items-center gap-2 text-xs">
									{category.code && (
										<span className="font-mono text-[11px] text-muted-foreground">
											{category.code}
										</span>
									)}
									<span className="truncate">{category.name}</span>
								</span>
								<AccountSelect
									label={`Expense account for ${category.name}`}
									value={categoryMap[category.id] ?? ""}
									options={expenseAccounts}
									emptyLabel={defaultExpense ? "↳ use default" : "— unmapped —"}
									onChange={(v) => {
										setCategoryMap((m) => ({ ...m, [category.id]: v }));
										setDirty(true);
									}}
								/>
							</li>
						))}
					</ul>
				)}
			</section>

			<section>
				<div className="mb-1 flex items-center justify-between">
					<h3 className="label-caps">Cards → payment accounts</h3>
					<Tag tone={mappedMethods === methods.length ? "success" : "neutral"}>
						{mappedMethods}/{methods.length}
					</Tag>
				</div>
				{methods.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">
						No payment methods captured yet.
					</p>
				) : (
					<ul className="divide-y divide-border rounded-sm border border-border">
						{methods.map((method) => {
							const payer = method.payingEntityId
								? entityById.get(method.payingEntityId)
								: undefined;
							return (
								<li
									key={method.id}
									className="grid items-center gap-1 px-2 py-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"
								>
									<span className="flex min-w-0 items-center gap-2 text-xs">
										{payer && <EntityDot color={payer.color} />}
										<span className="truncate">{method.label}</span>
										<span className="truncate text-[11px] text-muted-foreground">
											{payer
												? `paid by ${payer.shortName || payer.name}`
												: "unmapped payer"}
										</span>
									</span>
									<AccountSelect
										label={`Payment account for ${method.label}`}
										value={paymentMap[method.id] ?? ""}
										options={paymentAccounts}
										emptyLabel={
											defaultPayment ? "↳ use default" : "— unmapped —"
										}
										onChange={(v) => {
											setPaymentMap((m) => ({ ...m, [method.id]: v }));
											setDirty(true);
										}}
									/>
								</li>
							);
						})}
					</ul>
				)}
				<p className="mt-1 text-[11px] text-muted-foreground">
					Cards paid by another entity usually map to a clearing / due-to
					account (e.g. “Due to owner”) rather than a bank account.
				</p>
			</section>

			<div className="sticky bottom-0 flex items-center justify-end gap-2 border-t border-border bg-card py-2">
				{dirty && (
					<span className="text-[11px] text-amber-600 dark:text-amber-400">
						Unsaved changes
					</span>
				)}
				<Button
					variant="primary"
					disabled={!dirty || save.isPending}
					onClick={() => save.mutate()}
				>
					<IconDeviceFloppy /> Save mappings
				</Button>
			</div>
		</div>
	);
}
