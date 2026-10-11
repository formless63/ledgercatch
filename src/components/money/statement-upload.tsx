import { IconFileUpload, IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate } from "#/components/app/format";
import {
	Button,
	Field,
	Input,
	Money,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import type { PaymentMethodRow } from "#/features/ledger/hooks";
import {
	importStatement,
	previewStatement,
} from "#/features/money/money.functions";
import {
	type SignConvention,
	STATEMENT_PRESETS,
} from "#/features/money/statements";

const MAX_BYTES = 10 * 1024 * 1024;

async function toBase64(file: File) {
	const buffer = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let i = 0; i < buffer.length; i += 0x8000)
		binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
	return btoa(binary);
}

type Options = {
	presetId: string;
	signConvention: "" | SignConvention;
	currency: string;
	dayFirst: boolean;
	paymentMethodId: string;
};

export function StatementUpload({
	paymentMethods,
	onClose,
	onImported,
}: {
	paymentMethods: PaymentMethodRow[];
	onClose: () => void;
	onImported: () => void;
}) {
	const [file, setFile] = useState<{ name: string; base64: string } | null>(
		null,
	);
	const [options, setOptions] = useState<Options>({
		presetId: "",
		signConvention: "",
		currency: "",
		dayFirst: false,
		paymentMethodId: "",
	});
	const payload = (opts: Options, f = file) =>
		f
			? {
					fileName: f.name,
					base64: f.base64,
					presetId: opts.presetId || null,
					signConvention: opts.signConvention || null,
					currency: opts.currency || null,
					dayFirst: opts.dayFirst,
					paymentMethodId: opts.paymentMethodId || null,
				}
			: null;

	const preview = useMutation({
		mutationFn: (data: NonNullable<ReturnType<typeof payload>>) =>
			previewStatement({ data }),
		onSuccess: (result) => {
			setOptions((current) => ({
				...current,
				paymentMethodId:
					current.paymentMethodId || result.suggestedPaymentMethodId || "",
			}));
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const commit = useMutation({
		mutationFn: (data: NonNullable<ReturnType<typeof payload>>) =>
			importStatement({ data }),
		onSuccess: (result) => {
			toast.success(
				`Imported ${result.inserted} transactions (${result.duplicates} already known) · ${result.reconciliation.suggestions} suggested matches`,
			);
			onImported();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const update = (patch: Partial<Options>) => {
		const next = { ...options, ...patch };
		setOptions(next);
		const data = payload(next);
		if (data) preview.mutate(data);
	};

	const onFile = async (selected: File | undefined) => {
		if (!selected) return;
		if (selected.size > MAX_BYTES) {
			toast.error("File too large (max 10 MB)");
			return;
		}
		const next = { name: selected.name, base64: await toBase64(selected) };
		setFile(next);
		const data = payload(options, next);
		if (data) preview.mutate(data);
	};

	const result = preview.data;
	return (
		<Panel
			title="Import statement"
			action={
				<Button variant="ghost" size="xs" onClick={onClose} aria-label="Close">
					<IconX />
				</Button>
			}
		>
			<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
				<div className="flex flex-col gap-2">
					<Field
						label="File"
						hint="CSV, XLSX, OFX/QFX or QIF from your bank or card issuer (max 10 MB)."
					>
						<input
							type="file"
							accept=".csv,.tsv,.txt,.xlsx,.xls,.ofx,.qfx,.qbo,.qif"
							className="text-xs file:mr-2 file:rounded-sm file:border file:border-border file:bg-secondary file:px-2 file:py-0.5 file:text-xs"
							onChange={(event) => void onFile(event.target.files?.[0])}
						/>
					</Field>
					<Field label="Format / bank">
						<Select
							value={options.presetId}
							onChange={(event) => update({ presetId: event.target.value })}
						>
							<option value="">Auto-detect</option>
							{STATEMENT_PRESETS.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.label}
								</option>
							))}
						</Select>
					</Field>
					<Field
						label="Card / account"
						hint="Matches use this card's last 4 when orders know their card."
					>
						<Select
							value={options.paymentMethodId}
							onChange={(event) =>
								update({ paymentMethodId: event.target.value })
							}
						>
							<option value="">Unknown card</option>
							{paymentMethods.map((method) => (
								<option key={method.id} value={method.id}>
									{method.label}
									{method.last4 ? ` ··${method.last4}` : ""}
								</option>
							))}
						</Select>
					</Field>
					<div className="grid grid-cols-2 gap-2">
						<Field label="Charges are">
							<Select
								value={options.signConvention}
								onChange={(event) =>
									update({
										signConvention: event.target
											.value as Options["signConvention"],
									})
								}
							>
								<option value="">Auto</option>
								<option value="charges_positive">Positive</option>
								<option value="charges_negative">Negative</option>
							</Select>
						</Field>
						<Field label="Currency">
							<Input
								placeholder="USD"
								maxLength={3}
								value={options.currency}
								onChange={(event) =>
									setOptions({
										...options,
										currency: event.target.value.toUpperCase(),
									})
								}
								onBlur={() => update({})}
							/>
						</Field>
					</div>
					<label className="flex items-center gap-2 text-xs">
						<input
							type="checkbox"
							checked={options.dayFirst}
							onChange={(event) => update({ dayFirst: event.target.checked })}
						/>
						Dates are day-first (31/12/2026)
					</label>
					<Button
						variant="primary"
						size="md"
						disabled={!file || !result?.rowCount || commit.isPending}
						onClick={() => {
							const data = payload(options);
							if (data) commit.mutate(data);
						}}
					>
						<IconFileUpload />
						{commit.isPending
							? "Importing…"
							: `Import ${result ? result.rowCount - result.duplicates : 0} new`}
					</Button>
				</div>
				<div className="min-w-0">
					{preview.isPending && (
						<div className="text-xs text-muted-foreground">Reading file…</div>
					)}
					{result && !preview.isPending && (
						<div className="flex flex-col gap-2">
							<div className="flex flex-wrap items-center gap-1.5 text-xs">
								<Tag tone="primary">{result.presetLabel}</Tag>
								<Tag>{result.format}</Tag>
								{result.signConvention && (
									<Tag tone="info">
										{result.signConvention === "charges_negative"
											? "charges shown negative"
											: "charges shown positive"}
									</Tag>
								)}
								{result.accountHint && <Tag>acct ··{result.accountHint}</Tag>}
								<span className="text-muted-foreground">
									{result.rowCount} rows · {result.chargeCount} charges (
									<Money
										minor={result.chargeTotalMinor}
										currency={result.currency}
									/>
									) · {result.creditCount} credits · {result.paymentCount}{" "}
									payments · {result.duplicates} already imported
									{result.minDate &&
										` · ${formatDate(result.minDate)} – ${formatDate(result.maxDate)}`}
								</span>
							</div>
							{result.errors.length > 0 && (
								<ul className="rounded-sm border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
									{result.errors.slice(0, 5).map((error) => (
										<li key={`${error.row}-${error.message}`}>
											Row {error.row}: {error.message}
										</li>
									))}
								</ul>
							)}
							<div className="max-h-72 overflow-auto rounded-sm border border-border">
								<table className="w-full text-xs">
									<thead className="sticky top-0 bg-muted">
										<tr className="text-left">
											<th className="label-caps px-2 py-1">Date</th>
											<th className="label-caps px-2 py-1">Description</th>
											<th className="label-caps px-2 py-1">Merchant</th>
											<th className="label-caps px-2 py-1">Kind</th>
											<th className="label-caps px-2 py-1 text-right">
												Amount
											</th>
										</tr>
									</thead>
									<tbody>
										{result.sample.map((row, index) => (
											<tr
												// biome-ignore lint/suspicious/noArrayIndexKey: static preview
												key={index}
												className="h-7 border-t border-border"
											>
												<td className="px-2 font-mono">{row.date}</td>
												<td
													className="max-w-64 truncate px-2"
													title={row.description}
												>
													{row.description}
												</td>
												<td className="px-2 text-muted-foreground">
													{row.merchant}
												</td>
												<td className="px-2">
													<Tag
														tone={
															row.kind === "charge"
																? "neutral"
																: row.kind === "credit"
																	? "success"
																	: "info"
														}
													>
														{row.kind}
													</Tag>
												</td>
												<td className="px-2 text-right">
													<Money
														minor={row.amountMinor}
														currency={row.currency}
													/>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
							<p className="text-[11px] text-muted-foreground">
								Charges must show as positive amounts here. If purchases look
								like credits, flip “Charges are”.
							</p>
						</div>
					)}
					{!result && !preview.isPending && (
						<div className="flex h-full items-center justify-center rounded-sm border border-dashed border-border p-6 text-xs text-muted-foreground">
							Choose a file to preview its transactions.
						</div>
					)}
				</div>
			</div>
		</Panel>
	);
}
