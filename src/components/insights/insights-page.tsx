import { IconAlertTriangle, IconFileX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	ENTITY_STYLES,
	formatDate,
	formatMoney,
	storeLabel,
} from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Input,
	Money,
	PageHeader,
	Panel,
	ReimbursementTag,
	Select,
	StatTile,
	StoreMark,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import { TaxSummary } from "#/components/money/tax-summary";
import { ledgerKeys, useBootstrap } from "#/features/ledger/hooks";
import { getInsights } from "#/features/ledger/ledger.functions";
import { getInsightsSupplement } from "#/features/ledger/review-ui.functions";
import { Chart } from "#/integrations/charts/Chart";
import { cn } from "#/lib/utils";
import { type BarRow, HBars, StackedColumns } from "./bars";

export const RANGE_PRESETS = [
	"month",
	"last_month",
	"qtd",
	"ytd",
	"12m",
	"custom",
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const PRESET_LABELS: Record<RangePreset, string> = {
	month: "This month",
	last_month: "Last month",
	qtd: "QTD",
	ytd: "YTD",
	"12m": "Last 12 months",
	custom: "Custom",
};

export type InsightsSearch = {
	range?: RangePreset;
	from?: string;
	to?: string;
	entity?: string;
	cur?: string;
};

const iso = (date: Date) =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function presetRange(
	preset: RangePreset,
	custom: { from?: string; to?: string },
	now = new Date(),
) {
	const y = now.getFullYear();
	const m = now.getMonth();
	const today = iso(now);
	switch (preset) {
		case "month":
			return { from: iso(new Date(y, m, 1)), to: today };
		case "last_month":
			return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
		case "qtd":
			return { from: iso(new Date(y, m - (m % 3), 1)), to: today };
		case "ytd":
			return { from: iso(new Date(y, 0, 1)), to: today };
		case "custom": {
			const from = custom.from ?? iso(new Date(y, m - 11, 1));
			const to = custom.to ?? today;
			return from <= to ? { from, to } : { from: to, to: from };
		}
		default:
			return { from: iso(new Date(y, m - 11, 1)), to: today };
	}
}

function monthsBetween(from: string, to: string) {
	const months: string[] = [];
	let [y, m] = from.split("-").map(Number) as [number, number];
	const [ty, tm] = to.split("-").map(Number) as [number, number];
	while ((y < ty || (y === ty && m <= tm)) && months.length < 120) {
		months.push(`${y}-${String(m).padStart(2, "0")}`);
		m += 1;
		if (m > 12) {
			m = 1;
			y += 1;
		}
	}
	return months;
}

function monthLabel(month: string, withYear: boolean) {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
		month: "short",
		...(withYear ? { year: "2-digit" } : {}),
	});
}

/** Orders without a currency are shown as USD (same default as formatMoney). */
const cur = (currency: string | null) => currency ?? "USD";

function byCurrency<T extends { currency: string | null }>(
	rows: T[],
	currency: string,
) {
	return rows.filter((row) => cur(row.currency) === currency);
}

function sumMap<T>(
	rows: T[],
	key: (row: T) => string,
	value: (row: T) => number,
) {
	const map = new Map<string, number>();
	for (const row of rows)
		map.set(key(row), (map.get(key(row)) ?? 0) + value(row));
	return map;
}

function MoneyStack({
	totals,
}: {
	totals: Array<{ currency: string; amountMinor: number }>;
}) {
	if (totals.length === 0) return <span>—</span>;
	return (
		<span className="flex flex-col">
			{totals
				.sort((a, b) => b.amountMinor - a.amountMinor)
				.map((total) => (
					<Money
						key={total.currency}
						minor={total.amountMinor}
						currency={total.currency}
					/>
				))}
		</span>
	);
}

const REIMBURSEMENT_BAR: Record<string, string> = {
	pending: "bg-amber-500",
	submitted: "bg-cyan-500",
	reimbursed: "bg-emerald-500",
	rejected: "bg-red-500",
	none: "bg-zinc-500",
};

export function InsightsPage({
	search,
	onSearch,
}: {
	search: InsightsSearch;
	onSearch: (next: Partial<InsightsSearch>) => void;
}) {
	const { activeEntities, entityById } = useBootstrap();
	const preset = search.range ?? "12m";
	const range = presetRange(preset, search);
	const input = { ...range, entityId: search.entity };

	const insights = useQuery({
		queryKey: ledgerKeys.insights(input),
		queryFn: () => getInsights({ data: input }),
		placeholderData: (previous) => previous,
	});
	const supplement = useQuery({
		queryKey: ledgerKeys.insights({ ...input, supplement: true }),
		queryFn: () => getInsightsSupplement({ data: input }),
		placeholderData: (previous) => previous,
	});
	const data = insights.data;
	const extra = supplement.data;
	const filtered = !!search.entity;

	const spendTotals = useMemo(() => {
		if (!data) return [];
		return filtered
			? (extra?.totals ?? []).map((row) => ({
					currency: row.currency,
					amountMinor: row.amountMinor,
				}))
			: data.totals.map((row) => ({
					currency: cur(row.currency),
					amountMinor: row.amountMinor,
				}));
	}, [data, extra, filtered]);

	const currencies = [...spendTotals]
		.sort((a, b) => b.amountMinor - a.amountMinor)
		.map((row) => row.currency);
	for (const row of data?.byEntity ?? [])
		if (!currencies.includes(row.currency)) currencies.push(row.currency);
	const currency =
		search.cur && currencies.includes(search.cur)
			? search.cur
			: (currencies[0] ?? "USD");

	const [monthlyView, setMonthlyView] = useState<"stacked" | "trend">(
		"stacked",
	);

	const months = monthsBetween(range.from, range.to);
	const multiYear = months[0]?.slice(0, 4) !== months.at(-1)?.slice(0, 4);
	const monthRows = byCurrency(data?.byMonthEntity ?? [], currency);
	const seriesIds = [...new Set(monthRows.map((row) => row.entityId))];
	const series = seriesIds
		.map((id) => {
			const entity = entityById.get(id);
			return {
				key: id,
				label: entity?.name ?? "Unknown",
				color: entity?.color ?? "sky",
				sort: entity?.sort ?? 999,
			};
		})
		.sort((a, b) => a.sort - b.sort);
	const columns = months.map((month) => ({
		key: month,
		label: monthLabel(month, multiYear),
		values: Object.fromEntries(
			monthRows
				.filter((row) => row.month === month)
				.map((row) => [row.entityId, row.amountMinor]),
		),
	}));
	const exponent = currencyExponent(currency);
	const trend = columns.map((column) => ({
		label: column.label,
		value:
			Object.values(column.values).reduce((sum, value) => sum + value, 0) /
			10 ** exponent,
	}));

	const entityRows: BarRow[] = byCurrency(data?.byEntity ?? [], currency).map(
		(row) => {
			const entity = entityById.get(row.entityId);
			return {
				key: row.entityId,
				label: <EntityChip entity={entity} />,
				text: entity?.name ?? "Unknown",
				amountMinor: row.amountMinor,
				hint: `${row.orders} order${row.orders === 1 ? "" : "s"}`,
				barClass: ENTITY_STYLES[entity?.color ?? "sky"]?.bar,
			};
		},
	);
	const sourceData = filtered
		? (extra?.bySource ?? [])
		: (data?.bySource ?? []);
	const sourceRows: BarRow[] = byCurrency(sourceData, currency).map((row) => ({
		key: row.source,
		label: <StoreMark source={row.source} />,
		text: storeLabel(row.source),
		amountMinor: row.amountMinor,
		hint: `${row.orders} order${row.orders === 1 ? "" : "s"}`,
	}));
	const categoryRows: BarRow[] = [
		...sumMap(
			byCurrency(data?.byCategory ?? [], currency),
			(row) => row.categoryId ?? "none",
			(row) => row.amountMinor,
		).entries(),
	].map(([key, amountMinor]) => {
		const name =
			key === "none"
				? "Uncategorized"
				: (data?.byCategory.find((row) => row.categoryId === key)?.name ??
					"Unknown");
		return {
			key,
			label: (
				<span className={key === "none" ? "italic text-muted-foreground" : ""}>
					{name}
				</span>
			),
			text: name,
			amountMinor,
			barClass: key === "none" ? "bg-zinc-500/60" : "bg-primary/70",
		};
	});

	const reimbursement = byCurrency(data?.reimbursement ?? [], currency).sort(
		(a, b) =>
			["pending", "submitted", "rejected", "reimbursed", "none"].indexOf(
				a.status,
			) -
			["pending", "submitted", "rejected", "reimbursed", "none"].indexOf(
				b.status,
			),
	);
	const reimbursementTotal = reimbursement.reduce(
		(sum, row) => sum + row.amountMinor,
		0,
	);
	const pendingTotals = (data?.reimbursement ?? [])
		.filter((row) => row.status === "pending")
		.map((row) => ({ currency: row.currency, amountMinor: row.amountMinor }));
	const pendingCount = (data?.reimbursement ?? [])
		.filter((row) => row.status === "pending")
		.reduce((sum, row) => sum + row.count, 0);

	const ordersCount = filtered
		? (extra?.totals ?? []).reduce((sum, row) => sum + row.orders, 0)
		: (data?.totals ?? []).reduce((sum, row) => sum + row.orders, 0);
	const unassigned = (data?.totals ?? []).reduce(
		(sum, row) => sum + row.unassigned,
		0,
	);
	const missingCount = (extra?.totals ?? []).reduce(
		(sum, row) => sum + row.missingInvoices,
		0,
	);
	const missingList = (data?.missingInvoices ?? []).filter(
		(row) => !filtered || row.entityId === search.entity,
	);
	const taxTotals = (data?.totals ?? [])
		.filter((row) => row.taxMinor)
		.map((row) => ({
			currency: cur(row.currency),
			amountMinor: row.taxMinor,
		}));

	return (
		<div className="flex min-h-full flex-col">
			<PageHeader
				title="Insights"
				description={
					<span className="font-mono">
						{formatDate(range.from, "long")} – {formatDate(range.to, "long")}
						{filtered &&
							` · ${entityById.get(search.entity ?? "")?.name ?? ""}`}
					</span>
				}
			/>
			<div className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-2">
				<fieldset className="flex flex-wrap gap-1">
					<legend className="sr-only">Date range</legend>
					{RANGE_PRESETS.map((value) => (
						<Button
							key={value}
							size="sm"
							variant={preset === value ? "primary" : "ghost"}
							aria-pressed={preset === value}
							onClick={() =>
								onSearch(
									value === "custom"
										? { range: value, from: range.from, to: range.to }
										: { range: value, from: undefined, to: undefined },
								)
							}
						>
							{PRESET_LABELS[value]}
						</Button>
					))}
				</fieldset>
				{preset === "custom" && (
					<div className="flex items-center gap-1">
						<Input
							type="date"
							aria-label="From date"
							className="w-36"
							value={range.from}
							max={range.to}
							onChange={(event) =>
								event.target.value && onSearch({ from: event.target.value })
							}
						/>
						<span className="text-xs text-muted-foreground">–</span>
						<Input
							type="date"
							aria-label="To date"
							className="w-36"
							value={range.to}
							min={range.from}
							onChange={(event) =>
								event.target.value && onSearch({ to: event.target.value })
							}
						/>
					</div>
				)}
				<div className="ml-auto flex flex-wrap items-center gap-2">
					{/* biome-ignore lint/a11y/noLabelWithoutControl: wraps its Select */}
					<label className="flex items-center gap-1.5">
						<span className="label-caps">Entity</span>
						<Select
							className="w-40"
							value={search.entity ?? ""}
							onChange={(event) =>
								onSearch({ entity: event.target.value || undefined })
							}
						>
							<option value="">All entities</option>
							{activeEntities.map((entity) => (
								<option key={entity.id} value={entity.id}>
									{entity.name}
								</option>
							))}
						</Select>
					</label>
					{currencies.length > 1 && (
						<>
							{/* biome-ignore lint/a11y/noLabelWithoutControl: wraps its Select */}
							<label className="flex items-center gap-1.5">
								<span className="label-caps">Charts in</span>
								<Select
									className="w-20"
									value={currency}
									onChange={(event) => onSearch({ cur: event.target.value })}
								>
									{currencies.map((code) => (
										<option key={code} value={code}>
											{code}
										</option>
									))}
								</Select>
							</label>
						</>
					)}
				</div>
			</div>

			{insights.isError ? (
				<div className="p-4">
					<EmptyState
						icon={<IconAlertTriangle className="size-6" />}
						title="Could not load insights"
					>
						{errorMessage(insights.error)}
					</EmptyState>
				</div>
			) : !data ? (
				<div className="p-4 text-xs text-muted-foreground">Loading…</div>
			) : (
				<div
					className={cn(
						"flex flex-col gap-3 p-4 transition-opacity",
						insights.isFetching && "opacity-70",
					)}
				>
					<div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
						<StatTile
							label={filtered ? "Entity spend" : "Total spend"}
							value={<MoneyStack totals={spendTotals} />}
							hint={
								filtered ? "allocated to entity" : "excl. cancelled/ignored"
							}
						/>
						<StatTile
							label="Tax paid"
							value={<MoneyStack totals={taxTotals} />}
							hint={filtered ? "all entities" : "on orders in range"}
						/>
						<StatTile label="Orders" value={ordersCount} />
						<StatTile
							label="Unassigned"
							tone={unassigned ? "warning" : undefined}
							value={
								unassigned ? (
									<Link
										to="/app/orders"
										search={{ entity: "unassigned" }}
										className="hover:underline"
									>
										{unassigned}
									</Link>
								) : (
									0
								)
							}
							hint="orders without an entity"
						/>
						<StatTile
							label="Pending reimb."
							tone={pendingCount ? "warning" : undefined}
							value={<MoneyStack totals={pendingTotals} />}
							hint={
								<Link to="/app/reimbursements" className="hover:underline">
									{pendingCount} allocation{pendingCount === 1 ? "" : "s"} →
								</Link>
							}
						/>
						<StatTile
							label="Missing invoices"
							tone={missingCount ? "danger" : undefined}
							value={missingCount}
							hint="assigned orders"
						/>
					</div>

					<Panel
						title={`Monthly spend by entity · ${currency}`}
						action={
							<div className="flex gap-0.5">
								<Button
									size="xs"
									variant={monthlyView === "stacked" ? "secondary" : "ghost"}
									aria-pressed={monthlyView === "stacked"}
									onClick={() => setMonthlyView("stacked")}
								>
									Stacked
								</Button>
								<Button
									size="xs"
									variant={monthlyView === "trend" ? "secondary" : "ghost"}
									aria-pressed={monthlyView === "trend"}
									onClick={() => setMonthlyView("trend")}
								>
									Trend
								</Button>
							</div>
						}
					>
						{monthRows.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No assigned spend in this range.
							</p>
						) : monthlyView === "stacked" ? (
							<StackedColumns
								columns={columns}
								series={series}
								currency={currency}
								caption={`Monthly spend by entity in ${currency}`}
							/>
						) : (
							<Chart
								kind="area"
								className="text-primary"
								data={trend}
								title={`Monthly assigned spend in ${currency}`}
								description="Total allocated spend per month across the selected entities."
							/>
						)}
					</Panel>

					<div className="grid gap-3 lg:grid-cols-2">
						<Panel title={`Spend by entity · ${currency}`}>
							<HBars
								rows={entityRows}
								currency={currency}
								caption="Spend by entity"
							/>
						</Panel>
						<Panel title={`Spend by store · ${currency}`}>
							<HBars
								rows={sourceRows}
								currency={currency}
								caption="Spend by store"
							/>
							{!filtered && (
								<p className="mt-1 text-[10px] text-muted-foreground">
									Order totals, including unassigned orders.
								</p>
							)}
						</Panel>
						<Panel title={`Spend by category · ${currency}`}>
							<HBars
								rows={categoryRows}
								currency={currency}
								caption="Spend by category"
								limit={12}
							/>
						</Panel>
						<Panel title={`Reimbursements · ${currency}`}>
							{reimbursement.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									No reimbursable spend in this range.
								</p>
							) : (
								<>
									<div
										aria-hidden="true"
										className="mb-3 flex h-2.5 overflow-hidden rounded-sm bg-muted"
									>
										{reimbursement.map((row) => (
											<div
												key={row.status}
												className={
													REIMBURSEMENT_BAR[row.status] ?? "bg-zinc-500"
												}
												style={{
													width: `${(row.amountMinor / Math.max(1, reimbursementTotal)) * 100}%`,
												}}
											/>
										))}
									</div>
									<table className="w-full text-xs">
										<caption className="sr-only">
											Reimbursable spend by status
										</caption>
										<thead>
											<tr className="text-left">
												<th scope="col" className="label-caps pb-1">
													Status
												</th>
												<th scope="col" className="label-caps pb-1 text-right">
													Count
												</th>
												<th scope="col" className="label-caps pb-1 text-right">
													Amount
												</th>
											</tr>
										</thead>
										<tbody>
											{reimbursement.map((row) => (
												<tr key={row.status} className="h-7">
													<th scope="row" className="text-left font-normal">
														<ReimbursementTag status={row.status} />
													</th>
													<td className="text-right font-mono tabular-nums">
														{row.count}
													</td>
													<td className="text-right">
														<Money
															minor={row.amountMinor}
															currency={row.currency}
														/>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</>
							)}
						</Panel>
					</div>

					<Panel
						title={`Missing invoices (${missingList.length}${(data.missingInvoices.length ?? 0) >= 50 ? "+" : ""})`}
						bodyClassName="p-0"
						action={
							<Link
								to="/app/orders"
								search={{ missingInvoice: true }}
								className="text-[11px] text-primary hover:underline"
							>
								All in Orders →
							</Link>
						}
					>
						{missingList.length === 0 ? (
							<p className="p-3 text-xs text-muted-foreground">
								Every assigned order in range has an invoice or receipt.
							</p>
						) : (
							<>
								<p className="border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
									Open each order's store page with the extension to fetch its
									invoice.
								</p>
								<div className="overflow-x-auto">
									<table className="w-full min-w-[520px] text-xs">
										<caption className="sr-only">
											Orders missing invoices
										</caption>
										<thead>
											<tr className="h-6 border-b border-border text-left">
												<th scope="col" className="label-caps px-3">
													Date
												</th>
												<th scope="col" className="label-caps px-2">
													Store
												</th>
												<th scope="col" className="label-caps px-2">
													Merchant / order
												</th>
												<th scope="col" className="label-caps px-2">
													Entity
												</th>
												<th scope="col" className="label-caps px-3 text-right">
													Total
												</th>
											</tr>
										</thead>
										<tbody>
											{missingList.map((row) => (
												<tr
													key={row.id}
													className="h-7 border-b border-border last:border-0 hover:bg-accent/40"
												>
													<td className="whitespace-nowrap px-3 font-mono tabular-nums text-muted-foreground">
														{formatDate(row.orderDate)}
													</td>
													<td className="whitespace-nowrap px-2">
														<StoreMark source={row.source} />
													</td>
													<td className="max-w-[18rem] px-2">
														<Link
															to="/app/orders/$orderId"
															params={{ orderId: row.id }}
															className="flex min-w-0 items-center gap-1.5 hover:underline"
														>
															<IconFileX
																className="size-3.5 shrink-0 text-red-500"
																aria-hidden="true"
															/>
															<span className="truncate">
																{row.merchantName ?? "—"}
															</span>
															<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
																{row.externalOrderId ?? ""}
															</span>
														</Link>
													</td>
													<td className="px-2">
														<EntityChip
															entity={
																row.entityId
																	? entityById.get(row.entityId)
																	: null
															}
															short
														/>
													</td>
													<td className="whitespace-nowrap px-3 text-right">
														<Money
															minor={row.totalMinor}
															currency={row.currency}
														/>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</>
						)}
					</Panel>
					{currencies.length > 1 && (
						<p className="text-[11px] text-muted-foreground">
							Charts show {currency} only; amounts are never summed across
							currencies. Other currencies in range:{" "}
							{spendTotals
								.filter((row) => row.currency !== currency)
								.map((row) => formatMoney(row.amountMinor, row.currency))
								.join(" · ")}
						</p>
					)}
				</div>
			)}
			<div className="p-3 sm:p-4">
				<TaxSummary entityId={search.entity} />
			</div>
		</div>
	);
}

function currencyExponent(currency: string) {
	try {
		return (
			new Intl.NumberFormat("en", {
				style: "currency",
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
}
