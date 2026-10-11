import {
	IconArrowBackUp,
	IconCheck,
	IconFileUpload,
	IconPlus,
	IconRefresh,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate, formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Money,
	PageHeader,
	Panel,
	Select,
	StatTile,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import {
	confirmAllAbove,
	confirmMatches,
	createOrderFromTransaction,
	deleteStatementImport,
	getReconcileData,
	rejectMatch,
	rerunReconciliation,
	setTransactionsIgnored,
	unmatchTransaction,
} from "#/features/money/money.functions";
import { cn } from "#/lib/utils";
import { moneyKeys } from "./keys";
import { MoneySettingsPanel } from "./money-settings";
import { StatementUpload } from "./statement-upload";
import { TaxSummary } from "./tax-summary";

export type ReconcileTab = "review" | "imports" | "settings" | "tax";

function useMoneyMutation<TArgs, TResult>(
	fn: (args: TArgs) => Promise<TResult>,
	success?: (result: TResult) => string | null,
) {
	const client = useQueryClient();
	const invalidateLedger = useInvalidateLedger();
	return useMutation({
		mutationFn: fn,
		onSuccess: (result) => {
			const message = success?.(result);
			if (message) toast.success(message);
			void client.invalidateQueries({ queryKey: moneyKeys.all });
			void invalidateLedger();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
}

function scoreTone(score: number) {
	if (score >= 0.85) return "success" as const;
	if (score >= 0.7) return "info" as const;
	return "warning" as const;
}

export function ReconcilePage({
	tab,
	card,
	onSearch,
}: {
	tab: ReconcileTab;
	card: string | null;
	onSearch: (next: { tab?: ReconcileTab; card?: string | null }) => void;
}) {
	const {
		data: bootstrap,
		entityById,
		activeEntities,
		paymentMethodById,
	} = useBootstrap();
	const client = useQueryClient();
	const [uploading, setUploading] = useState(false);
	const [entityForNew, setEntityForNew] = useState("");
	const filter = { paymentMethodId: card };
	const data = useQuery({
		queryKey: moneyKeys.reconcile(filter),
		queryFn: () => getReconcileData({ data: filter }),
		placeholderData: (previous) => previous,
	});

	const confirm = useMoneyMutation(
		(matchIds: string[]) => confirmMatches({ data: { matchIds } }),
		(r) => `Confirmed ${r.confirmed}`,
	);
	const confirmHigh = useMoneyMutation(
		() => confirmAllAbove({ data: { minScore: 0.9 } }),
		(r) => `Confirmed ${r.confirmed} high-confidence matches`,
	);
	const reject = useMoneyMutation((id: string) =>
		rejectMatch({ data: { id } }),
	);
	const unmatch = useMoneyMutation((id: string) =>
		unmatchTransaction({ data: { id } }),
	);
	const ignore = useMoneyMutation(
		(input: { ids: string[]; ignored: boolean }) =>
			setTransactionsIgnored({
				data: { transactionIds: input.ids, ignored: input.ignored },
			}),
	);
	const createOrder = useMoneyMutation(
		(transactionId: string) =>
			createOrderFromTransaction({
				data: { transactionId, entityId: entityForNew || null },
			}),
		() => "Manual order created",
	);
	const rerun = useMoneyMutation(
		() => rerunReconciliation(),
		(r) =>
			`Matched ${r.transactions} open transactions · ${r.suggestions} suggestions`,
	);
	const removeImport = useMoneyMutation(
		(id: string) => deleteStatementImport({ data: { id } }),
		(r) => `Removed ${r.removed} transactions`,
	);

	const d = data.data;
	const totals = (d?.completeness ?? []).reduce(
		(acc, row) => ({
			charges: acc.charges + row.charges,
			matched: acc.matched + row.matched,
			ignored: acc.ignored + row.ignored,
			suggested: acc.suggested + row.suggested,
			unmatched: acc.unmatched + row.unmatched,
		}),
		{ charges: 0, matched: 0, ignored: 0, suggested: 0, unmatched: 0 },
	);
	const overallPercent =
		totals.charges - totals.ignored > 0
			? Math.round((totals.matched / (totals.charges - totals.ignored)) * 100)
			: null;
	const cardLabel = (id: string | null) => {
		const method = id ? paymentMethodById.get(id) : undefined;
		return method
			? `${method.label}${method.last4 ? ` ··${method.last4}` : ""}`
			: "Unknown card";
	};

	// Split suggestions share a group: show once with all charges.
	const suggestionGroups = new Map<
		string,
		NonNullable<typeof d>["suggested"]
	>();
	for (const row of d?.suggested ?? []) {
		const key = row.groupKey ?? row.id;
		suggestionGroups.set(key, [...(suggestionGroups.get(key) ?? []), row]);
	}

	return (
		<div className="flex min-h-full flex-col">
			<PageHeader
				title="Reconcile"
				description="Card and bank statements against captured orders: what was charged that the ledger misses, and what the ledger has that was never charged."
				actions={
					<>
						<Select
							className="w-48"
							value={card ?? ""}
							onChange={(event) =>
								onSearch({ card: event.target.value || null })
							}
						>
							<option value="">All cards</option>
							{(bootstrap?.paymentMethods ?? []).map((method) => (
								<option key={method.id} value={method.id}>
									{method.label}
									{method.last4 ? ` ··${method.last4}` : ""}
								</option>
							))}
						</Select>
						<Button
							onClick={() => rerun.mutate(undefined)}
							disabled={rerun.isPending}
						>
							<IconRefresh />
							Re-match
						</Button>
						<Button variant="primary" onClick={() => setUploading(true)}>
							<IconFileUpload />
							Import statement
						</Button>
					</>
				}
			/>
			<div className="flex flex-col gap-3 p-4">
				{uploading && (
					<StatementUpload
						paymentMethods={bootstrap?.paymentMethods ?? []}
						onClose={() => setUploading(false)}
						onImported={() => {
							setUploading(false);
							void client.invalidateQueries({ queryKey: moneyKeys.all });
						}}
					/>
				)}
				<div className="grid grid-cols-2 gap-2 md:grid-cols-5">
					<StatTile
						label="Completeness"
						value={overallPercent == null ? "—" : `${overallPercent}%`}
						hint={`${totals.matched} of ${totals.charges - totals.ignored} charges matched`}
						tone={
							overallPercent == null
								? undefined
								: overallPercent >= 95
									? "success"
									: overallPercent >= 75
										? "warning"
										: "danger"
						}
					/>
					<StatTile
						label="Suggested"
						value={suggestionGroups.size}
						hint="awaiting confirmation"
						tone={suggestionGroups.size ? "primary" : undefined}
					/>
					<StatTile
						label="Unmatched"
						value={d?.unmatched.length ?? "—"}
						hint="charges/credits without an order"
						tone={d?.unmatched.length ? "warning" : undefined}
					/>
					<StatTile
						label="No charge found"
						value={d?.missingCharges.length ?? "—"}
						hint={
							d?.coverage
								? `orders ${formatDate(d.coverage.from)} – ${formatDate(d.coverage.to)}`
								: "import a statement first"
						}
						tone={d?.missingCharges.length ? "warning" : undefined}
					/>
					<StatTile
						label="Not purchases"
						value={d?.ignored.length ?? "—"}
						hint="payments, fees, ignored"
					/>
				</div>

				<nav className="flex gap-1 border-b border-border">
					{(
						[
							["review", "Review"],
							["imports", "Statements & cards"],
							["tax", "Tax summary"],
							["settings", "Currency & tax profile"],
						] as Array<[ReconcileTab, string]>
					).map(([key, label]) => (
						<button
							key={key}
							type="button"
							onClick={() => onSearch({ tab: key })}
							className={cn(
								"-mb-px border-b-2 px-3 py-1.5 text-xs",
								tab === key
									? "border-primary font-semibold text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
						>
							{label}
						</button>
					))}
				</nav>

				{tab === "review" && (
					<>
						{data.isError && (
							<div className="text-xs text-red-500">
								{errorMessage(data.error)}
							</div>
						)}
						{d && !d.imports.length && (
							<EmptyState
								icon={<IconFileUpload className="size-6" />}
								title="No statements yet"
								action={
									<Button variant="primary" onClick={() => setUploading(true)}>
										Import statement
									</Button>
								}
							>
								Export a CSV, XLSX, OFX/QFX or QIF from your card issuer or
								bank. Chase, Amex, Capital One, Citi, Discover, Apple Card and
								PayPal layouts are detected automatically.
							</EmptyState>
						)}

						<Panel
							title={`Suggested matches (${suggestionGroups.size})`}
							bodyClassName="p-0"
							action={
								<Button
									size="xs"
									disabled={!suggestionGroups.size || confirmHigh.isPending}
									onClick={() => confirmHigh.mutate(undefined)}
								>
									<IconCheck />
									Confirm all ≥ 90%
								</Button>
							}
						>
							{suggestionGroups.size === 0 ? (
								<div className="p-3 text-xs text-muted-foreground">
									Nothing waiting for confirmation.
								</div>
							) : (
								<table className="w-full text-xs">
									<thead className="bg-muted/50 text-left">
										<tr>
											<th className="label-caps px-3 py-1">Statement</th>
											<th className="label-caps px-3 py-1">Order</th>
											<th className="label-caps px-3 py-1">Why</th>
											<th className="label-caps px-3 py-1 text-right">Score</th>
											<th className="px-3 py-1" />
										</tr>
									</thead>
									<tbody>
										{[...suggestionGroups.values()].map((group) => {
											const first = group[0];
											if (!first) return null;
											return (
												<tr
													key={first.id}
													className="border-t border-border align-top"
												>
													<td className="px-3 py-1.5">
														{group.map((row) => (
															<div
																key={row.id}
																className="flex items-center gap-2"
															>
																<span className="font-mono text-muted-foreground">
																	{row.txDate}
																</span>
																<span
																	className="max-w-56 truncate"
																	title={row.txDescription}
																>
																	{row.txDescription}
																</span>
																<Money
																	minor={row.txAmountMinor}
																	currency={row.txCurrency}
																/>
															</div>
														))}
														<div className="text-[11px] text-muted-foreground">
															{cardLabel(first.txPaymentMethodId)}
														</div>
													</td>
													<td className="px-3 py-1.5">
														<Link
															to="/app/orders/$orderId"
															params={{ orderId: first.orderId }}
															className="flex items-center gap-2 hover:underline"
														>
															<StoreMark source={first.orderSource} />
															<span className="truncate font-mono text-muted-foreground">
																{first.orderExternalId}
															</span>
														</Link>
														<div className="flex items-center gap-2">
															<span className="font-mono text-muted-foreground">
																{first.orderDate}
															</span>
															<Money
																minor={first.orderTotalMinor}
																currency={first.orderCurrency}
															/>
															<EntityChip
																short
																entity={
																	first.orderEntityId
																		? entityById.get(first.orderEntityId)
																		: null
																}
															/>
														</div>
													</td>
													<td className="px-3 py-1.5">
														<div className="flex flex-wrap gap-1">
															{first.kind !== "single" && (
																<Tag
																	tone={
																		first.kind === "refund" ? "success" : "info"
																	}
																>
																	{first.kind}
																</Tag>
															)}
															{first.reasons.map((reason) => (
																<Tag key={reason}>{reason}</Tag>
															))}
														</div>
													</td>
													<td className="px-3 py-1.5 text-right">
														<Tag tone={scoreTone(first.score)}>
															{Math.round(first.score * 100)}%
														</Tag>
													</td>
													<td className="px-3 py-1.5">
														<div className="flex justify-end gap-1">
															<Button
																size="xs"
																variant="primary"
																onClick={() => confirm.mutate([first.id])}
															>
																<IconCheck />
																Confirm
															</Button>
															<Button
																size="xs"
																variant="ghost"
																onClick={() => reject.mutate(first.id)}
																aria-label="Reject"
															>
																<IconX />
															</Button>
														</div>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							)}
						</Panel>

						<Panel
							title={`Unmatched transactions (${d?.unmatched.length ?? 0})`}
							bodyClassName="p-0"
							action={
								<Select
									className="w-44"
									value={entityForNew}
									onChange={(event) => setEntityForNew(event.target.value)}
									title="Entity for orders created from transactions"
								>
									<option value="">New orders → inbox</option>
									{activeEntities.map((entity) => (
										<option key={entity.id} value={entity.id}>
											New orders → {entity.name}
										</option>
									))}
								</Select>
							}
						>
							{!d?.unmatched.length ? (
								<div className="p-3 text-xs text-muted-foreground">
									Every imported transaction is matched or set aside.
								</div>
							) : (
								<table className="w-full text-xs">
									<tbody>
										{d.unmatched.map((row) => (
											<tr
												key={row.id}
												className="h-7 border-t border-border first:border-t-0"
											>
												<td className="w-24 px-3 font-mono text-muted-foreground">
													{row.date}
												</td>
												<td
													className="max-w-80 truncate px-3"
													title={row.description}
												>
													{row.description}
												</td>
												<td className="px-3 text-muted-foreground">
													{cardLabel(row.paymentMethodId)}
												</td>
												<td className="px-3">
													{row.kind !== "charge" && <Tag>{row.kind}</Tag>}
												</td>
												<td className="px-3 text-right">
													<Money
														minor={row.amountMinor}
														currency={row.currency}
													/>
												</td>
												<td className="px-3">
													<div className="flex justify-end gap-1">
														{row.amountMinor > 0 && (
															<Button
																size="xs"
																onClick={() => createOrder.mutate(row.id)}
																disabled={createOrder.isPending}
																title="Create a manual order from this charge"
															>
																<IconPlus />
																Create order
															</Button>
														)}
														<Button
															size="xs"
															variant="ghost"
															onClick={() =>
																ignore.mutate({ ids: [row.id], ignored: true })
															}
														>
															Not a purchase
														</Button>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Panel>

						<Panel
							title={`Orders with no charge found (${d?.missingCharges.length ?? 0})`}
							bodyClassName="p-0"
						>
							{!d?.missingCharges.length ? (
								<div className="p-3 text-xs text-muted-foreground">
									{d?.coverage
										? "Every order in the statement period has a charge."
										: "Shown once statements cover the orders' dates."}
								</div>
							) : (
								<table className="w-full text-xs">
									<tbody>
										{d.missingCharges.map((order) => (
											<tr
												key={order.id}
												className="h-7 border-t border-border first:border-t-0"
											>
												<td className="w-24 px-3 font-mono text-muted-foreground">
													{order.orderDate}
												</td>
												<td className="px-3">
													<Link
														to="/app/orders/$orderId"
														params={{ orderId: order.id }}
														className="flex items-center gap-2 hover:underline"
													>
														<StoreMark source={order.source} />
														<span className="font-mono text-muted-foreground">
															{order.externalOrderId}
														</span>
													</Link>
												</td>
												<td className="px-3 text-muted-foreground">
													{order.paymentMethodId
														? cardLabel(order.paymentMethodId)
														: "card unknown"}
												</td>
												<td className="px-3">
													<EntityChip
														short
														entity={
															order.entityId
																? entityById.get(order.entityId)
																: null
														}
													/>
												</td>
												<td className="px-3 text-right">
													<Money
														minor={order.totalMinor}
														currency={order.currency}
													/>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Panel>

						{!!d?.ignored.length && (
							<Panel
								title={`Not purchases (${d.ignored.length})`}
								bodyClassName="p-0"
							>
								<table className="w-full text-xs">
									<tbody>
										{d.ignored.map((row) => (
											<tr
												key={row.id}
												className="h-7 border-t border-border text-muted-foreground first:border-t-0"
											>
												<td className="w-24 px-3 font-mono">{row.date}</td>
												<td className="max-w-80 truncate px-3">
													{row.description}
												</td>
												<td className="px-3">
													<Tag>{row.kind}</Tag>
												</td>
												<td className="px-3 text-right">
													<Money
														minor={row.amountMinor}
														currency={row.currency}
														muted
													/>
												</td>
												<td className="px-3 text-right">
													<Button
														size="xs"
														variant="ghost"
														onClick={() =>
															ignore.mutate({ ids: [row.id], ignored: false })
														}
													>
														<IconArrowBackUp />
														Restore
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</Panel>
						)}
					</>
				)}

				{tab === "imports" && (
					<>
						<Panel title="Completeness per card" bodyClassName="p-0">
							{!d?.completeness.length ? (
								<div className="p-3 text-xs text-muted-foreground">
									No statements imported.
								</div>
							) : (
								<table className="w-full text-xs">
									<thead className="bg-muted/50 text-left">
										<tr>
											<th className="label-caps px-3 py-1">Card</th>
											<th className="label-caps px-3 py-1">Period</th>
											<th className="label-caps px-3 py-1 text-right">
												Charges
											</th>
											<th className="label-caps px-3 py-1 text-right">
												Matched
											</th>
											<th className="label-caps px-3 py-1 text-right">Open</th>
											<th className="label-caps px-3 py-1 text-right">
												Amount matched
											</th>
											<th className="label-caps px-3 py-1">Complete</th>
										</tr>
									</thead>
									<tbody>
										{d.completeness.map((row) => (
											<tr
												key={`${row.paymentMethodId}-${row.currency}`}
												className="h-8 border-t border-border"
											>
												<td className="px-3">
													{cardLabel(row.paymentMethodId)}
												</td>
												<td className="px-3 font-mono text-muted-foreground">
													{row.minDate} – {row.maxDate}
												</td>
												<td className="px-3 text-right font-mono">
													{row.charges}
												</td>
												<td className="px-3 text-right font-mono">
													{row.matched}
												</td>
												<td className="px-3 text-right font-mono">
													{row.unmatched + row.suggested}
												</td>
												<td className="px-3 text-right">
													<Money
														minor={row.matchedMinor}
														currency={row.currency}
													/>{" "}
													/{" "}
													<Money
														minor={row.chargeMinor}
														currency={row.currency}
														muted
													/>
												</td>
												<td className="w-48 px-3">
													<div className="flex items-center gap-2">
														<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
															<div
																className={cn(
																	"h-full",
																	(row.percent ?? 0) >= 95
																		? "bg-emerald-500"
																		: (row.percent ?? 0) >= 75
																			? "bg-amber-500"
																			: "bg-red-500",
																)}
																style={{ width: `${row.percent ?? 0}%` }}
															/>
														</div>
														<span className="w-12 text-right font-mono">
															{row.percent == null ? "—" : `${row.percent}%`}
														</span>
													</div>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Panel>
						<Panel title="Imported statements" bodyClassName="p-0">
							{!d?.imports.length ? (
								<div className="p-3 text-xs text-muted-foreground">
									Nothing imported yet.
								</div>
							) : (
								<table className="w-full text-xs">
									<tbody>
										{d.imports.map((row) => (
											<tr
												key={row.id}
												className="h-8 border-t border-border first:border-t-0"
											>
												<td
													className="max-w-64 truncate px-3"
													title={row.fileName}
												>
													{row.fileName}
												</td>
												<td className="px-3">
													<Tag>{row.presetId ?? row.format}</Tag>
												</td>
												<td className="px-3 text-muted-foreground">
													{cardLabel(row.paymentMethodId)}
													{row.accountHint &&
														!row.paymentMethodId &&
														` (acct ··${row.accountHint})`}
												</td>
												<td className="px-3 font-mono text-muted-foreground">
													{row.minDate} – {row.maxDate}
												</td>
												<td className="px-3 font-mono">
													{row.insertedCount} new / {row.duplicateCount} dup
												</td>
												<td className="px-3 text-muted-foreground">
													{formatRelative(row.createdAt)}
												</td>
												<td className="px-3 text-right">
													<Button
														size="xs"
														variant="danger"
														onClick={() => {
															if (
																window.confirm(
																	`Remove ${row.insertedCount} transactions imported from ${row.fileName}? Orders are not touched.`,
																)
															)
																removeImport.mutate(row.id);
														}}
													>
														<IconTrash />
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Panel>
						<Panel title="Recently confirmed" bodyClassName="p-0">
							{!d?.confirmed.length ? (
								<div className="p-3 text-xs text-muted-foreground">
									No confirmed matches yet.
								</div>
							) : (
								<table className="w-full text-xs">
									<tbody>
										{d.confirmed.map((row) => (
											<tr
												key={row.id}
												className="h-7 border-t border-border first:border-t-0"
											>
												<td className="w-24 px-3 font-mono text-muted-foreground">
													{row.txDate}
												</td>
												<td
													className="max-w-72 truncate px-3"
													title={row.txDescription}
												>
													{row.txDescription}
												</td>
												<td className="px-3 text-right">
													<Money
														minor={row.txAmountMinor}
														currency={row.txCurrency}
													/>
												</td>
												<td className="px-3">
													<Link
														to="/app/orders/$orderId"
														params={{ orderId: row.orderId }}
														className="flex items-center gap-2 hover:underline"
													>
														<StoreMark source={row.orderSource} />
														<span className="font-mono text-muted-foreground">
															{row.orderExternalId}
														</span>
													</Link>
												</td>
												<td className="px-3">
													{row.kind !== "single" && <Tag>{row.kind}</Tag>}
												</td>
												<td className="px-3 text-right">
													<Button
														size="xs"
														variant="ghost"
														onClick={() => unmatch.mutate(row.transactionId)}
													>
														<IconArrowBackUp />
														Undo
													</Button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</Panel>
					</>
				)}

				{tab === "tax" && <TaxSummary />}
				{tab === "settings" && <MoneySettingsPanel />}
			</div>
		</div>
	);
}
