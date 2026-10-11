/**
 * Items (#5 + #16): "where did I buy X" search across line items, grouped by
 * SKU or normalized title, with price history per store and reorder links.
 */
import {
	IconExternalLink,
	IconPhoto,
	IconSearch,
	IconShoppingCartPlus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { formatDate, storeLabel } from "#/components/app/format";
import {
	EmptyState,
	Input,
	Money,
	PageHeader,
	Panel,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/orders/shared";
import { lifecycleKeys } from "#/features/lifecycle/hooks";
import {
	type ItemGroup,
	priceSeries,
	unitPrice,
} from "#/features/lifecycle/items";
import type { ItemSearchResult } from "#/features/lifecycle/items.server";
import {
	getItemHistory,
	searchItems,
} from "#/features/lifecycle/lifecycle.functions";
import { cn } from "#/lib/utils";
import { todayIso } from "./shared";

type GroupRow = ItemSearchResult["groups"][number];

const SERIES_COLORS = [
	"stroke-sky-400",
	"stroke-emerald-400",
	"stroke-purple-400",
	"stroke-amber-400",
	"stroke-pink-400",
];
const DOT_COLORS = [
	"bg-sky-400",
	"bg-emerald-400",
	"bg-purple-400",
	"bg-amber-400",
	"bg-pink-400",
];

function daysAgo(date: string | null) {
	if (!date) return null;
	return Math.round(
		(Date.parse(`${todayIso()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
			86_400_000,
	);
}

export function ItemsPage({
	q,
	selected,
	onSearch,
}: {
	q: string;
	selected?: string;
	onSearch: (next: { q?: string; key?: string }) => void;
}) {
	const [text, setText] = useState(q);
	useEffect(() => {
		const t = setTimeout(() => {
			if (text.trim() !== q)
				onSearch({ q: text.trim() || undefined, key: undefined });
		}, 300);
		return () => clearTimeout(t);
	}, [text, q, onSearch]);

	const query = useQuery({
		queryKey: lifecycleKeys.items(q),
		queryFn: () => searchItems({ data: { q, limit: 400 } }),
		placeholderData: (prev) => prev,
	});
	const groups = query.data?.groups ?? [];
	const active = groups.find((g) => g.key === selected) ?? null;

	return (
		<div className="flex flex-col">
			<PageHeader
				title="Items"
				description="Where did I buy it, what did I pay, and when — across every store."
			/>
			<div className="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4">
				<div className="relative w-full max-w-md">
					<IconSearch className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						autoFocus
						aria-label="Search items"
						placeholder="Item title, SKU or variant…  (e.g. pla filament, USB-C cable)"
						value={text}
						onChange={(e) => setText(e.target.value)}
						className="h-8 pl-7 text-[13px]"
					/>
				</div>
				{query.data && (
					<span className="font-mono text-[11px] text-muted-foreground">
						{groups.length} items · {query.data.total} purchases
						{query.data.truncated ? " (showing latest)" : ""}
					</span>
				)}
			</div>
			<div className="grid grid-cols-1 gap-3 px-3 pb-4 sm:px-4 lg:grid-cols-[minmax(0,1fr)_380px]">
				<div className="min-w-0">
					{query.isPending ? (
						<div className="h-48 animate-pulse rounded bg-muted" />
					) : query.isError ? (
						<EmptyState title="Search failed">
							{errorMessage(query.error)}
						</EmptyState>
					) : groups.length === 0 ? (
						<EmptyState
							title={q ? `Nothing matches “${q}”` : "No line items yet"}
						>
							Items appear here once orders with line items are captured.
						</EmptyState>
					) : (
						<div className="overflow-x-auto rounded border border-border bg-card">
							<table className="w-full min-w-[720px] border-collapse text-xs">
								<thead>
									<tr className="h-7 border-b border-border text-left">
										<th className="w-9 px-2">
											<span className="sr-only">Image</span>
										</th>
										<th className="label-caps px-2">Item</th>
										<th className="label-caps w-32 px-2">Stores</th>
										<th className="label-caps w-16 px-2 text-right">Orders</th>
										<th className="label-caps w-24 px-2">Last bought</th>
										<th className="label-caps w-20 px-2 text-right">Last</th>
										<th className="label-caps w-32 px-2 text-right">Range</th>
										<th className="w-16 px-2">
											<span className="sr-only">Reorder</span>
										</th>
									</tr>
								</thead>
								<tbody>
									{groups.map((group) => (
										<ItemRow
											key={group.key}
											group={group}
											active={group.key === selected}
											onSelect={() =>
												onSearch({
													key: group.key === selected ? undefined : group.key,
												})
											}
										/>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
				<div className="min-w-0">
					{active ? (
						<HistoryPanel group={active} />
					) : (
						<Panel title="Price history">
							<p className="text-xs text-muted-foreground">
								Select an item to see every purchase, unit price over time per
								store and a reorder link.
							</p>
						</Panel>
					)}
				</div>
			</div>
		</div>
	);
}

function ItemRow({
	group,
	active,
	onSelect,
}: {
	group: GroupRow;
	active: boolean;
	onSelect: () => void;
}) {
	const ago = daysAgo(group.lastPurchaseDate);
	return (
		<tr
			onClick={onSelect}
			className={cn(
				"h-9 cursor-pointer border-b border-border/60 last:border-0 hover:bg-accent/40",
				active && "bg-accent/60",
			)}
		>
			<td className="px-2">
				{group.imageUrl ? (
					<img
						src={group.imageUrl}
						alt=""
						loading="lazy"
						referrerPolicy="no-referrer"
						className="size-7 rounded-[3px] border border-border bg-muted object-cover"
					/>
				) : (
					<span className="grid size-7 place-items-center rounded-[3px] border border-border bg-muted text-muted-foreground">
						<IconPhoto className="size-3.5" />
					</span>
				)}
			</td>
			<td className="max-w-0 px-2">
				<button
					type="button"
					className="block w-full truncate text-left hover:underline"
					title={group.title}
					onClick={(e) => {
						e.stopPropagation();
						onSelect();
					}}
				>
					{group.title}
				</button>
				<div className="truncate font-mono text-[10px] text-muted-foreground">
					{[
						group.sku,
						group.cadenceDays ? `~every ${group.cadenceDays}d` : null,
					]
						.filter(Boolean)
						.join(" · ") || `×${group.totalQuantity}`}
				</div>
			</td>
			<td className="max-w-0 truncate px-2 text-muted-foreground">
				{group.stores.map(storeLabel).join(", ")}
			</td>
			<td className="px-2 text-right font-mono tabular-nums">
				{group.purchases}
			</td>
			<td className="px-2 font-mono text-[11px]">
				{formatDate(group.lastPurchaseDate)}
				{ago != null && (
					<span className="ml-1 text-[10px] text-muted-foreground">{ago}d</span>
				)}
			</td>
			<td className="px-2 text-right">
				<Money minor={group.lastUnitPriceMinor} currency={group.currency} />
			</td>
			<td className="px-2 text-right text-[11px]">
				{group.minUnitPriceMinor != null &&
				group.minUnitPriceMinor !== group.maxUnitPriceMinor ? (
					<>
						<Money
							minor={group.minUnitPriceMinor}
							currency={group.currency}
							muted
						/>
						<span className="text-muted-foreground">–</span>
						<Money
							minor={group.maxUnitPriceMinor}
							currency={group.currency}
							muted
						/>
					</>
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</td>
			<td className="px-2">
				{group.reorderUrl && (
					<a
						href={group.reorderUrl}
						target="_blank"
						rel="noreferrer"
						onClick={(e) => e.stopPropagation()}
						className="inline-flex h-5 items-center gap-1 rounded-sm border border-border px-1.5 text-[11px] hover:bg-accent"
						title="Open the product page to reorder"
					>
						<IconShoppingCartPlus className="size-3" />
						Buy
					</a>
				)}
			</td>
		</tr>
	);
}

function HistoryPanel({ group }: { group: GroupRow }) {
	const history = useQuery({
		queryKey: lifecycleKeys.itemHistory(group.title, group.sku),
		queryFn: () =>
			getItemHistory({ data: { title: group.title, sku: group.sku } }),
	});
	const full: ItemGroup | null = history.data ?? null;
	const rows = full?.rows ?? group.recent;
	const currency = full?.currency ?? group.currency;
	const series = useMemo(() => priceSeries(rows, currency), [rows, currency]);

	return (
		<Panel
			title="Price history"
			action={
				(full?.reorderUrl ?? group.reorderUrl) && (
					<a
						href={(full?.reorderUrl ?? group.reorderUrl) as string}
						target="_blank"
						rel="noreferrer"
						className="inline-flex h-5 items-center gap-1 rounded-sm border border-primary bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground hover:opacity-90"
					>
						<IconShoppingCartPlus className="size-3" />
						Reorder
					</a>
				)
			}
		>
			<div className="flex flex-col gap-3">
				<div className="text-xs font-medium leading-snug">{group.title}</div>
				<div className="grid grid-cols-3 gap-2 text-xs">
					<Metric label="Last">
						<Money
							minor={full?.lastUnitPriceMinor ?? group.lastUnitPriceMinor}
							currency={currency}
						/>
					</Metric>
					<Metric label="Low">
						<Money
							minor={full?.minUnitPriceMinor ?? group.minUnitPriceMinor}
							currency={currency}
						/>
					</Metric>
					<Metric label="High">
						<Money
							minor={full?.maxUnitPriceMinor ?? group.maxUnitPriceMinor}
							currency={currency}
						/>
					</Metric>
				</div>
				<PriceChart series={series} currency={currency} />
				{history.isPending && (
					<div className="h-4 w-1/2 animate-pulse rounded-sm bg-muted" />
				)}
				<ul className="flex max-h-80 flex-col overflow-y-auto">
					{rows.map((row) => (
						<li
							key={row.itemId}
							className="flex items-center gap-2 border-b border-border/60 py-1 text-xs last:border-0"
						>
							<span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">
								{formatDate(row.orderDate)}
							</span>
							<StoreMark source={row.source} className="min-w-0 text-[11px]" />
							<Link
								to="/app/orders/$orderId"
								params={{ orderId: row.orderId }}
								className="min-w-0 truncate font-mono text-[10px] text-muted-foreground hover:underline"
								title={row.variant ?? row.title}
							>
								{row.externalOrderId}
							</Link>
							<span className="ml-auto flex shrink-0 items-center gap-1.5">
								{row.quantity !== 1 && (
									<span className="font-mono text-[10px] text-muted-foreground">
										×{row.quantity}
									</span>
								)}
								<Money minor={unitPrice(row)} currency={row.currency} />
								{row.itemUrl && (
									<a
										href={row.itemUrl}
										target="_blank"
										rel="noreferrer"
										aria-label="Open product page"
										className="text-muted-foreground hover:text-foreground"
									>
										<IconExternalLink className="size-3" />
									</a>
								)}
							</span>
						</li>
					))}
				</ul>
				{full?.cadenceDays && (
					<Tag tone="info" className="self-start">
						usually reordered every ~{full.cadenceDays} days
					</Tag>
				)}
			</div>
		</Panel>
	);
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="rounded-sm border border-border px-2 py-1">
			<div className="label-caps">{label}</div>
			<div className="font-mono">{children}</div>
		</div>
	);
}

/** Minimal inline SVG line chart: unit price over time, one line per store. */
function PriceChart({
	series,
	currency,
}: {
	series: ReturnType<typeof priceSeries>;
	currency: string | null;
}) {
	const points = [...series.values()].flat();
	if (points.length < 2)
		return (
			<p className="text-[11px] text-muted-foreground">
				Not enough priced purchases{currency ? ` in ${currency}` : ""} for a
				chart.
			</p>
		);
	const times = points.map((p) => Date.parse(p.date));
	const prices = points.map((p) => p.unitPriceMinor);
	const [t0, t1] = [Math.min(...times), Math.max(...times)];
	const [p0, p1] = [Math.min(...prices), Math.max(...prices)];
	const W = 340;
	const H = 90;
	const x = (t: number) =>
		t1 === t0 ? W / 2 : 6 + ((t - t0) / (t1 - t0)) * (W - 12);
	const y = (p: number) =>
		p1 === p0 ? H / 2 : H - 6 - ((p - p0) / (p1 - p0)) * (H - 12);
	const stores = [...series.keys()];
	return (
		<div className="flex flex-col gap-1">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="h-24 w-full rounded-sm border border-border bg-background"
				role="img"
				aria-label="Unit price over time by store"
			>
				{stores.map((store, i) => {
					const list = series.get(store) ?? [];
					const color = SERIES_COLORS[i % SERIES_COLORS.length];
					return (
						<g key={store} className={color}>
							{list.length > 1 && (
								<polyline
									fill="none"
									strokeWidth={1.5}
									points={list
										.map(
											(p) => `${x(Date.parse(p.date))},${y(p.unitPriceMinor)}`,
										)
										.join(" ")}
								/>
							)}
							{list.map((p) => (
								<circle
									key={`${p.orderId}-${p.date}`}
									cx={x(Date.parse(p.date))}
									cy={y(p.unitPriceMinor)}
									r={2.5}
									className="fill-card"
									strokeWidth={1.5}
								/>
							))}
						</g>
					);
				})}
			</svg>
			<div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
				{stores.map((store, i) => (
					<span key={store} className="inline-flex items-center gap-1">
						<span
							className={cn(
								"size-1.5 rounded-full",
								DOT_COLORS[i % DOT_COLORS.length],
							)}
						/>
						{storeLabel(store)}
					</span>
				))}
			</div>
		</div>
	);
}
