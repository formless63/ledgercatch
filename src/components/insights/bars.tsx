/** Lightweight CSS bar visualizations (single currency per chart). */
import type { ReactNode } from "react";
import { ENTITY_STYLES, formatMoney } from "#/components/app/format";
import { cn } from "#/lib/utils";

export type BarRow = {
	key: string;
	label: ReactNode;
	/** Plain-text label for the accessible table. */
	text: string;
	amountMinor: number;
	hint?: ReactNode;
	barClass?: string;
};

/** Horizontal ranked bars with amount and share. */
export function HBars({
	rows,
	currency,
	caption,
	limit = 10,
}: {
	rows: BarRow[];
	currency: string;
	caption: string;
	limit?: number;
}) {
	const sorted = [...rows].sort((a, b) => b.amountMinor - a.amountMinor);
	const shown = sorted.slice(0, limit);
	const rest = sorted.slice(limit);
	const restTotal = rest.reduce((sum, row) => sum + row.amountMinor, 0);
	const total = sorted.reduce((sum, row) => sum + row.amountMinor, 0);
	const max = Math.max(1, ...shown.map((row) => row.amountMinor));
	if (sorted.length === 0)
		return <p className="text-xs text-muted-foreground">No spend in range.</p>;
	return (
		<table className="w-full text-xs">
			<caption className="sr-only">{caption}</caption>
			<thead className="sr-only">
				<tr>
					<th scope="col">Name</th>
					<th scope="col">Amount</th>
					<th scope="col">Share</th>
				</tr>
			</thead>
			<tbody>
				{shown.map((row) => (
					<tr key={row.key} className="align-middle">
						<th
							scope="row"
							className="w-[38%] max-w-0 py-1 pr-2 text-left font-normal"
						>
							<div className="truncate">{row.label}</div>
							{row.hint && (
								<div className="truncate text-[10px] text-muted-foreground">
									{row.hint}
								</div>
							)}
						</th>
						<td className="py-1">
							<div className="flex items-center gap-2">
								<div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
									<div
										className={cn(
											"h-full rounded-sm",
											row.barClass ?? "bg-primary/70",
										)}
										style={{ width: `${(row.amountMinor / max) * 100}%` }}
									/>
								</div>
							</div>
						</td>
						<td className="w-[1%] whitespace-nowrap py-1 pl-2 text-right font-mono tabular-nums">
							{formatMoney(row.amountMinor, currency)}
						</td>
						<td className="w-[1%] whitespace-nowrap py-1 pl-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
							{total ? `${Math.round((row.amountMinor / total) * 100)}%` : ""}
						</td>
					</tr>
				))}
				{rest.length > 0 && (
					<tr>
						<th
							scope="row"
							className="py-1 pr-2 text-left font-normal text-muted-foreground"
						>
							{rest.length} more
						</th>
						<td />
						<td className="whitespace-nowrap py-1 pl-2 text-right font-mono tabular-nums text-muted-foreground">
							{formatMoney(restTotal, currency)}
						</td>
						<td className="whitespace-nowrap py-1 pl-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
							{total ? `${Math.round((restTotal / total) * 100)}%` : ""}
						</td>
					</tr>
				)}
			</tbody>
		</table>
	);
}

export type StackSeries = { key: string; label: string; color: string };

/** Vertical stacked columns (e.g. month × entity). */
export function StackedColumns({
	columns,
	series,
	currency,
	caption,
}: {
	columns: Array<{
		key: string;
		label: string;
		values: Record<string, number>;
	}>;
	series: StackSeries[];
	currency: string;
	caption: string;
}) {
	const totals = columns.map((column) =>
		Object.values(column.values).reduce((sum, value) => sum + value, 0),
	);
	const max = Math.max(1, ...totals);
	return (
		<div>
			<div
				aria-hidden="true"
				className="flex h-44 items-end gap-[3px] border-b border-border sm:gap-1.5"
			>
				{columns.map((column, index) => (
					<div
						key={column.key}
						className="group relative flex h-full min-w-0 flex-1 flex-col justify-end"
						title={`${column.label}: ${formatMoney(totals[index] ?? 0, currency)}\n${series
							.filter((s) => column.values[s.key])
							.map(
								(s) =>
									`${s.label}: ${formatMoney(column.values[s.key] ?? 0, currency)}`,
							)
							.join("\n")}`}
					>
						<div
							className="flex flex-col-reverse overflow-hidden rounded-t-sm group-hover:opacity-80"
							style={{ height: `${((totals[index] ?? 0) / max) * 100}%` }}
						>
							{series.map((s) => {
								const value = column.values[s.key] ?? 0;
								if (!value || !totals[index]) return null;
								return (
									<div
										key={s.key}
										className={ENTITY_STYLES[s.color]?.bar ?? "bg-zinc-500"}
										style={{
											height: `${(value / (totals[index] ?? 1)) * 100}%`,
										}}
									/>
								);
							})}
						</div>
					</div>
				))}
			</div>
			<div
				aria-hidden="true"
				className="mt-1 flex gap-[3px] font-mono text-[9px] text-muted-foreground sm:gap-1.5"
			>
				{columns.map((column, index) => (
					<div key={column.key} className="min-w-0 flex-1 truncate text-center">
						{columns.length > 14 && index % 2 === 1 ? "" : column.label}
					</div>
				))}
			</div>
			<ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
				{series.map((s) => (
					<li key={s.key} className="flex items-center gap-1.5">
						<span
							className={cn(
								"size-2 rounded-[2px]",
								ENTITY_STYLES[s.color]?.bar ?? "bg-zinc-500",
							)}
						/>
						{s.label}
					</li>
				))}
			</ul>
			<table className="sr-only">
				<caption>{caption}</caption>
				<thead>
					<tr>
						<th scope="col">Month</th>
						{series.map((s) => (
							<th key={s.key} scope="col">
								{s.label}
							</th>
						))}
						<th scope="col">Total</th>
					</tr>
				</thead>
				<tbody>
					{columns.map((column, index) => (
						<tr key={column.key}>
							<th scope="row">{column.label}</th>
							{series.map((s) => (
								<td key={s.key}>
									{formatMoney(column.values[s.key] ?? 0, currency)}
								</td>
							))}
							<td>{formatMoney(totals[index] ?? 0, currency)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
