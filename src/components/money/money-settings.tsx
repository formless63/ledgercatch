import { IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "#/components/app/format";
import {
	Button,
	EntityDot,
	Field,
	Input,
	Panel,
	Select,
} from "#/components/app/primitives";
import { errorMessage } from "#/components/captures/drawer";
import {
	TAX_BUSINESS_TYPES,
	TAX_JURISDICTIONS,
	type TaxBusinessType,
	type TaxJurisdiction,
} from "#/features/money/constants";
import {
	getMoneySettings,
	refreshFx,
	saveEntitySettings,
	saveUserReportingCurrency,
} from "#/features/money/money.functions";
import { moneyKeys } from "./keys";

const BUSINESS_LABELS: Record<TaxBusinessType, string> = {
	personal: "Personal",
	sole_prop: "Sole proprietor (Schedule C)",
	single_member_llc: "Single-member LLC (Schedule C)",
	partnership: "Partnership / multi-member LLC (1065)",
	s_corp: "S corporation (1120-S)",
	c_corp: "C corporation (1120)",
	other: "Other",
};

/** Reporting currency (user + per entity), entity tax profiles, FX status. */
export function MoneySettingsPanel() {
	const client = useQueryClient();
	const settings = useQuery({
		queryKey: moneyKeys.settings,
		queryFn: () => getMoneySettings(),
	});
	const [currency, setCurrency] = useState("");
	useEffect(() => {
		if (settings.data) setCurrency(settings.data.reportingCurrency);
	}, [settings.data]);
	const done = () => void client.invalidateQueries({ queryKey: moneyKeys.all });
	const saveUser = useMutation({
		mutationFn: (value: string) =>
			saveUserReportingCurrency({ data: { reportingCurrency: value } }),
		onSuccess: () => {
			toast.success("Reporting currency saved");
			done();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const saveEntity = useMutation({
		mutationFn: (data: {
			entityId: string;
			reportingCurrency: string | null;
			taxJurisdiction: TaxJurisdiction | null;
			taxBusinessType: TaxBusinessType | null;
		}) => saveEntitySettings({ data }),
		onSuccess: () => {
			toast.success("Entity settings saved");
			done();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const fetchFx = useMutation({
		mutationFn: (backfillDays: number) => refreshFx({ data: { backfillDays } }),
		onSuccess: (result) => {
			toast.success(
				`Stored ${result.stored} rates (latest ${result.latest ?? "—"})`,
			);
			done();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const data = settings.data;
	const currencies = data?.fx.currencies.length
		? data.fx.currencies
		: ["USD", "EUR"];
	return (
		<div className="grid gap-3 lg:grid-cols-2">
			<Panel title="Reporting currency">
				<div className="flex items-end gap-2">
					<Field
						label="Default"
						hint="Insights, reimbursement and tax summaries convert each amount at the ECB reference rate of its order date."
						className="flex-1"
					>
						<Input
							maxLength={3}
							value={currency}
							list="money-currencies"
							onChange={(event) =>
								setCurrency(event.target.value.toUpperCase())
							}
						/>
					</Field>
					<Button
						variant="primary"
						disabled={!/^[A-Z]{3}$/.test(currency) || saveUser.isPending}
						onClick={() => saveUser.mutate(currency)}
					>
						Save
					</Button>
				</div>
				<datalist id="money-currencies">
					{currencies.map((code) => (
						<option key={code} value={code} />
					))}
				</datalist>
			</Panel>
			<Panel
				title="FX rates (ECB reference)"
				action={
					<div className="flex gap-1">
						<Button
							size="xs"
							onClick={() => fetchFx.mutate(0)}
							disabled={fetchFx.isPending}
						>
							<IconRefresh />
							Fetch latest
						</Button>
						<Button
							size="xs"
							onClick={() => fetchFx.mutate(730)}
							disabled={fetchFx.isPending}
						>
							Backfill 2y
						</Button>
					</div>
				}
			>
				{data ? (
					<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
						<dt className="text-muted-foreground">Rates stored</dt>
						<dd className="font-mono">{data.fx.rows}</dd>
						<dt className="text-muted-foreground">Range</dt>
						<dd className="font-mono">
							{data.fx.first ?? "—"} – {data.fx.last ?? "—"}
						</dd>
						<dt className="text-muted-foreground">Last fetch</dt>
						<dd className="font-mono">{formatRelative(data.fx.fetchedAt)}</dd>
						<dt className="text-muted-foreground">Currencies</dt>
						<dd className="font-mono">{data.fx.currencies.length}</dd>
					</dl>
				) : (
					<div className="text-xs text-muted-foreground">Loading…</div>
				)}
			</Panel>
			<Panel title="Per entity" className="lg:col-span-2" bodyClassName="p-0">
				<table className="w-full text-xs">
					<thead className="bg-muted/50 text-left">
						<tr>
							<th className="label-caps px-3 py-1">Entity</th>
							<th className="label-caps px-3 py-1">Reporting currency</th>
							<th className="label-caps px-3 py-1">Tax jurisdiction</th>
							<th className="label-caps px-3 py-1">Business type</th>
							<th className="px-3 py-1" />
						</tr>
					</thead>
					<tbody>
						{(data?.entities ?? [])
							.filter((entity) => !entity.archivedAt)
							.map((entity) => (
								<EntityRow
									key={`${entity.entityId}-${entity.reportingCurrency}-${entity.taxJurisdiction}-${entity.taxBusinessType}`}
									entity={entity}
									saving={saveEntity.isPending}
									onSave={(values) =>
										saveEntity.mutate({ entityId: entity.entityId, ...values })
									}
								/>
							))}
					</tbody>
				</table>
				<p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
					The tax profile only changes which form/line hints are shown. Hints
					are advisory and never applied automatically.
				</p>
			</Panel>
		</div>
	);
}

function EntityRow({
	entity,
	saving,
	onSave,
}: {
	entity: {
		entityId: string;
		name: string;
		color: string;
		reportingCurrency: string | null;
		taxJurisdiction: TaxJurisdiction | null;
		taxBusinessType: TaxBusinessType | null;
	};
	saving: boolean;
	onSave: (values: {
		reportingCurrency: string | null;
		taxJurisdiction: TaxJurisdiction | null;
		taxBusinessType: TaxBusinessType | null;
	}) => void;
}) {
	const [currency, setCurrency] = useState(entity.reportingCurrency ?? "");
	const [jurisdiction, setJurisdiction] = useState(
		entity.taxJurisdiction ?? "",
	);
	const [type, setType] = useState(entity.taxBusinessType ?? "");
	const valid = !currency || /^[A-Z]{3}$/.test(currency);
	return (
		<tr className="h-9 border-t border-border">
			<td className="px-3">
				<span className="flex items-center gap-2">
					<EntityDot color={entity.color} />
					{entity.name}
				</span>
			</td>
			<td className="w-36 px-3">
				<Input
					maxLength={3}
					placeholder="default"
					value={currency}
					onChange={(event) => setCurrency(event.target.value.toUpperCase())}
				/>
			</td>
			<td className="w-36 px-3">
				<Select
					value={jurisdiction}
					onChange={(event) => setJurisdiction(event.target.value)}
				>
					<option value="">Not set</option>
					{TAX_JURISDICTIONS.map((code) => (
						<option key={code} value={code}>
							{code === "US" ? "United States" : "Other"}
						</option>
					))}
				</Select>
			</td>
			<td className="w-64 px-3">
				<Select value={type} onChange={(event) => setType(event.target.value)}>
					<option value="">Not set</option>
					{TAX_BUSINESS_TYPES.map((code) => (
						<option key={code} value={code}>
							{BUSINESS_LABELS[code]}
						</option>
					))}
				</Select>
			</td>
			<td className="px-3 text-right">
				<Button
					size="xs"
					disabled={!valid || saving}
					onClick={() =>
						onSave({
							reportingCurrency: currency || null,
							taxJurisdiction: (jurisdiction || null) as TaxJurisdiction | null,
							taxBusinessType: (type || null) as TaxBusinessType | null,
						})
					}
				>
					Save
				</Button>
			</td>
		</tr>
	);
}
