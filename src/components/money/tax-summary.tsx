import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	EmptyState,
	EntityChip,
	Money,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import { getTaxSummary } from "#/features/money/money.functions";
import { moneyKeys } from "./keys";

/**
 * Year-end summary per entity by accepted tax treatment, in each entity's
 * reporting currency. Mountable in Insights or the Reconcile page.
 */
export function TaxSummary({
	year: initialYear,
	entityId,
}: {
	year?: number;
	entityId?: string;
}) {
	const current = new Date().getFullYear();
	const [year, setYear] = useState(initialYear ?? current);
	const input = { year, ...(entityId ? { entityId } : {}) };
	const query = useQuery({
		queryKey: moneyKeys.taxSummary(input),
		queryFn: () => getTaxSummary({ data: input }),
		placeholderData: (previous) => previous,
	});
	const data = query.data;
	return (
		<Panel
			title="Tax summary"
			bodyClassName="p-0"
			action={
				<Select
					className="w-24"
					value={String(year)}
					onChange={(event) => setYear(Number(event.target.value))}
				>
					{Array.from({ length: 6 }, (_, i) => current - i).map((y) => (
						<option key={y} value={y}>
							{y}
						</option>
					))}
				</Select>
			}
		>
			{query.isError && (
				<div className="p-3 text-xs text-red-500">
					{errorMessage(query.error)}
				</div>
			)}
			{data && !data.entities.length && (
				<EmptyState title={`No assigned spend in ${year}`} className="m-3" />
			)}
			{data?.entities.map((group) => (
				<div
					key={group.entity.id}
					className="border-b border-border last:border-b-0"
				>
					<div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-1.5 text-xs">
						<EntityChip entity={group.entity} />
						<span className="flex items-center gap-2">
							{!group.profile.jurisdiction && (
								<Tag tone="warning">no tax profile</Tag>
							)}
							{group.unconverted > 0 && (
								<Tag tone="warning">{group.unconverted} without FX rate</Tag>
							)}
							<Money
								minor={group.totalMinor}
								currency={group.currency}
								className="font-semibold"
							/>
						</span>
					</div>
					<table className="w-full text-xs">
						<tbody>
							{group.rows.map((row) => (
								<tr key={row.treatment} className="h-7 border-t border-border">
									<td className="px-3">
										<span
											className={
												row.treatment === "unreviewed"
													? "text-muted-foreground italic"
													: "font-medium"
											}
										>
											{row.label}
										</span>
										{row.hint && (
											<span className="text-muted-foreground">
												{" "}
												— {row.hint}
											</span>
										)}
									</td>
									<td className="w-20 px-3 text-right font-mono text-muted-foreground">
										{row.count}
									</td>
									<td className="w-32 px-3 text-right">
										<Money minor={row.amountMinor} currency={group.currency} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			))}
			{!!data?.flags.length && (
				<div className="border-t border-border p-3">
					<div className="label-caps mb-1">
						Allocations ≥ $2,500 accepted as expenses
					</div>
					<table className="w-full text-xs">
						<tbody>
							{data.flags.map((flag) => (
								<tr key={flag.allocationId} className="h-7">
									<td className="w-24 font-mono text-muted-foreground">
										{flag.orderDate}
									</td>
									<td>
										<Link
											to="/app/orders/$orderId"
											params={{ orderId: flag.orderId }}
											className="hover:underline"
										>
											{flag.merchant}
										</Link>
									</td>
									<td className="text-muted-foreground">{flag.treatment}</td>
									<td className="text-right">
										<Money minor={flag.amountMinor} currency={flag.currency} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{data && (
				<p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
					{data.disclaimer}
				</p>
			)}
		</Panel>
	);
}
