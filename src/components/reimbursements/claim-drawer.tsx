import { IconFileCheck, IconFileX, IconPrinter } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { formatDate, formatMoney, storeLabel } from "#/components/app/format";
import {
	Button,
	EntityChip,
	Money,
	SectionLabel,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { Drawer, errorMessage, MetaList } from "#/components/captures/drawer";
import { ledgerKeys, useInvalidateLedger } from "#/features/ledger/hooks";
import { setClaimStatus } from "#/features/ledger/ledger.functions";
import { getClaimReport } from "#/features/ledger/review-ui.functions";
import { CLAIM_TONES, ClaimActions } from "./claim-shared";

type Report = Awaited<ReturnType<typeof getClaimReport>>;

export function ClaimDrawer({
	claimId,
	onClose,
}: {
	claimId: string | null;
	onClose: () => void;
}) {
	const invalidate = useInvalidateLedger();
	const query = useQuery({
		queryKey: [...ledgerKeys.reimbursements, "claim", claimId],
		queryFn: () => getClaimReport({ data: { id: claimId as string } }),
		enabled: !!claimId,
	});
	const setStatus = useMutation({
		mutationFn: (status: "draft" | "submitted" | "paid" | "void") =>
			setClaimStatus({ data: { id: claimId as string, status } }),
		onSuccess: () => {
			toast.success("Claim updated");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const report = query.data;
	const claim = report?.claim;
	const missing = report?.lines.filter((line) => line.documents.length === 0);

	return (
		<Drawer
			open={!!claimId}
			onClose={onClose}
			title={
				claim ? `Claim ${claim.reference ?? claim.id.slice(0, 8)}` : "Claim"
			}
			subtitle={
				report ? (
					<span>
						{report.owing?.name ?? "?"} owes {report.payer?.name ?? "?"}
					</span>
				) : undefined
			}
			actions={
				claim && (
					<>
						<ClaimActions
							status={claim.status}
							disabled={setStatus.isPending}
							onStatus={(status) => setStatus.mutate(status)}
						/>
						<Button size="xs" onClick={() => window.print()}>
							<IconPrinter />
							Print
						</Button>
					</>
				)
			}
		>
			{query.isError ? (
				<div className="p-4 text-xs text-red-600 dark:text-red-400">
					{errorMessage(query.error)}
				</div>
			) : !report || !claim ? (
				<div className="p-4 text-xs text-muted-foreground">Loading…</div>
			) : (
				<div className="flex flex-col gap-4 p-3">
					<div className="flex flex-wrap items-center gap-3">
						<EntityChip entity={report.owing} />
						<span className="text-xs text-muted-foreground">owes</span>
						<EntityChip entity={report.payer} />
						<Money
							minor={claim.totalMinor}
							currency={claim.currency}
							className="ml-auto text-xl font-semibold"
						/>
					</div>
					<MetaList
						items={[
							{
								label: "Status",
								value: (
									<Tag tone={CLAIM_TONES[claim.status] ?? "neutral"}>
										{claim.status}
									</Tag>
								),
							},
							{
								label: "Reference",
								value: (
									<span className="font-mono">{claim.reference ?? "—"}</span>
								),
							},
							{
								label: "Created",
								value: (
									<span className="font-mono">
										{formatDate(claim.createdAt, "long")}
									</span>
								),
							},
							{
								label: "Submitted",
								value: (
									<span className="font-mono">
										{formatDate(claim.submittedAt, "long")}
									</span>
								),
							},
							{
								label: "Paid",
								value: (
									<span className="font-mono">
										{formatDate(claim.paidAt, "long")}
									</span>
								),
							},
							...(claim.notes ? [{ label: "Notes", value: claim.notes }] : []),
						]}
					/>
					{missing && missing.length > 0 && (
						<p className="rounded-sm border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
							{missing.length} order{missing.length === 1 ? " has" : "s have"}{" "}
							no invoice or receipt attached. Open the order in the store with
							the extension to fetch it.
						</p>
					)}
					<section aria-label="Line items">
						<SectionLabel className="mb-1">
							Lines ({report.lines.length})
						</SectionLabel>
						{report.lines.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No orders attached{claim.status === "void" ? " (voided)" : ""}.
							</p>
						) : (
							<ul className="divide-y divide-border rounded-sm border border-border">
								{report.lines.map((line) => (
									<li key={line.allocationId} className="px-2 py-1.5 text-xs">
										<div className="flex items-center gap-2">
											<span className="w-16 shrink-0 font-mono tabular-nums text-muted-foreground">
												{formatDate(line.orderDate)}
											</span>
											<StoreMark source={line.source} className="shrink-0" />
											<Link
												to="/app/orders/$orderId"
												params={{ orderId: line.orderId }}
												className="min-w-0 flex-1 truncate hover:underline"
											>
												{line.merchantName ?? "—"}{" "}
												<span className="font-mono text-[11px] text-muted-foreground">
													{line.externalOrderId ?? line.orderId.slice(0, 8)}
												</span>
											</Link>
											{line.documents.length > 0 ? (
												<IconFileCheck
													className="size-3.5 shrink-0 text-emerald-500"
													aria-label="Invoice attached"
												/>
											) : (
												<IconFileX
													className="size-3.5 shrink-0 text-red-500"
													aria-label="Invoice missing"
												/>
											)}
											<Money
												minor={line.amountMinor}
												currency={line.currency}
												className="shrink-0"
											/>
										</div>
										{line.items.length > 0 && (
											<div className="mt-0.5 truncate pl-[4.5rem] text-[11px] text-muted-foreground">
												{line.items
													.map((item) =>
														item.quantity && item.quantity !== 1
															? `${item.quantity}× ${item.title}`
															: item.title,
													)
													.join(" · ")}
											</div>
										)}
									</li>
								))}
							</ul>
						)}
					</section>
					<ClaimPrint report={report} />
				</div>
			)}
		</Drawer>
	);
}

/**
 * Print-only expense report. Portaled to <body> so `window.print()` can hide
 * the app shell and paginate the report normally.
 */
function ClaimPrint({ report }: { report: Report }) {
	if (typeof document === "undefined") return null;
	const { claim, lines } = report;
	const totalTax = lines.reduce(
		(sum, line) =>
			sum +
			(line.orderTaxMinor && line.orderTotalMinor
				? Math.round(
						(line.orderTaxMinor * line.amountMinor) / line.orderTotalMinor,
					)
				: 0),
		0,
	);
	return createPortal(
		<div className="claim-print hidden bg-white p-8 font-sans text-[11px] text-black print:block">
			<style>
				{
					"@media print { body > *:not(.claim-print) { display: none !important; } body { background: white !important; } @page { margin: 14mm; } }"
				}
			</style>
			<header className="mb-4 flex items-start justify-between border-b border-black pb-3">
				<div>
					<h1 className="text-xl font-bold">Expense reimbursement claim</h1>
					<p className="mt-1">
						<strong>{report.owing?.name ?? "—"}</strong> owes{" "}
						<strong>{report.payer?.name ?? "—"}</strong> for purchases paid on
						its behalf.
					</p>
				</div>
				<table className="text-right">
					<tbody>
						<tr>
							<th className="pr-2 font-normal">Reference</th>
							<td className="font-mono">
								{claim.reference ?? claim.id.slice(0, 8)}
							</td>
						</tr>
						<tr>
							<th className="pr-2 font-normal">Status</th>
							<td className="uppercase">{claim.status}</td>
						</tr>
						<tr>
							<th className="pr-2 font-normal">Submitted</th>
							<td className="font-mono">
								{formatDate(claim.submittedAt ?? claim.createdAt, "long")}
							</td>
						</tr>
						{claim.paidAt && (
							<tr>
								<th className="pr-2 font-normal">Paid</th>
								<td className="font-mono">
									{formatDate(claim.paidAt, "long")}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</header>
			<table className="w-full border-collapse">
				<thead>
					<tr className="border-b border-black text-left">
						<th className="py-1 pr-2">Date</th>
						<th className="py-1 pr-2">Vendor</th>
						<th className="py-1 pr-2">Order #</th>
						<th className="py-1 pr-2">Description</th>
						<th className="py-1 pr-2">Category</th>
						<th className="py-1 pr-2">Paid with</th>
						<th className="py-1 pr-2">Receipt</th>
						<th className="py-1 text-right">Amount</th>
					</tr>
				</thead>
				<tbody>
					{lines.map((line) => (
						<tr
							key={line.allocationId}
							className="break-inside-avoid border-b border-gray-300 align-top"
						>
							<td className="py-1 pr-2 font-mono whitespace-nowrap">
								{line.orderDate}
							</td>
							<td className="py-1 pr-2">
								{line.merchantName ?? storeLabel(line.source)}
								{line.merchantName && (
									<div className="text-[10px] text-gray-600">
										{storeLabel(line.source)}
									</div>
								)}
							</td>
							<td className="py-1 pr-2 font-mono">
								{line.externalOrderId ?? "—"}
							</td>
							<td className="py-1 pr-2">
								{line.items
									.slice(0, 6)
									.map((item) =>
										item.quantity && item.quantity !== 1
											? `${item.quantity}× ${item.title}`
											: item.title,
									)
									.join("; ")}
								{line.items.length > 6 && ` (+${line.items.length - 6} more)`}
							</td>
							<td className="py-1 pr-2">
								{line.categoryCode ? `${line.categoryCode} ` : ""}
								{line.categoryName ?? ""}
							</td>
							<td className="py-1 pr-2">
								{line.paymentLabel ?? ""}
								{line.paymentLast4 ? ` ••${line.paymentLast4}` : ""}
							</td>
							<td className="py-1 pr-2">
								{line.documents.length
									? line.documents.map((doc) => doc.fileName).join(", ")
									: "missing"}
							</td>
							<td className="py-1 text-right font-mono whitespace-nowrap">
								{formatMoney(line.amountMinor, line.currency)}
							</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					{totalTax > 0 && (
						<tr>
							<td colSpan={7} className="pt-2 text-right">
								of which tax (proportional, est.)
							</td>
							<td className="pt-2 text-right font-mono">
								{formatMoney(totalTax, claim.currency)}
							</td>
						</tr>
					)}
					<tr className="border-t-2 border-black font-bold">
						<td colSpan={7} className="py-1.5 text-right">
							Total due ({lines.length} item{lines.length === 1 ? "" : "s"})
						</td>
						<td className="py-1.5 text-right font-mono">
							{formatMoney(claim.totalMinor, claim.currency)}
						</td>
					</tr>
				</tfoot>
			</table>
			{claim.notes && (
				<p className="mt-4 whitespace-pre-wrap">
					<strong>Notes:</strong> {claim.notes}
				</p>
			)}
			<div className="mt-12 grid grid-cols-2 gap-12">
				<div className="border-t border-black pt-1">
					Approved by ({report.owing?.name ?? ""})
				</div>
				<div className="border-t border-black pt-1">Date</div>
			</div>
			<p className="mt-6 text-[9px] text-gray-500">
				Claim {claim.id} · generated {new Date().toLocaleDateString()}
			</p>
		</div>,
		document.body,
	);
}
