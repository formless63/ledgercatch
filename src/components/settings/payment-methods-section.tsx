import {
	IconAlertTriangle,
	IconArchive,
	IconArrowBackUp,
	IconCreditCard,
	IconPlus,
	IconX,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { formatDate } from "#/components/app/format";
import {
	Button,
	EntityDot,
	Field,
	Input,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import {
	type PaymentMethodRow,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import { savePaymentMethod } from "#/features/ledger/ledger.functions";
import { cn } from "#/lib/utils";
import { Callout, errorText } from "./ui";

type Usage = Record<
	string,
	{ orders: number; lastUsed: string | null; totalMinor: number }
>;

type SaveInput = {
	method?: PaymentMethodRow;
	label: string;
	brand?: string;
	last4?: string;
	payingEntityId: string | null;
	archived?: boolean;
};

function MethodRow({
	method,
	usage,
	onSave,
	pending,
}: {
	method: PaymentMethodRow;
	usage: Usage[string] | undefined;
	onSave: (input: SaveInput) => void;
	pending: boolean;
}) {
	const { activeEntities, entityById } = useBootstrap();
	const [label, setLabel] = useState(method.label);
	const archived = Boolean(method.archivedAt);
	const unmapped = !archived && !method.payingEntityId;
	const payer = method.payingEntityId
		? entityById.get(method.payingEntityId)
		: undefined;
	const commitLabel = () => {
		const next = label.trim();
		if (!next) return setLabel(method.label);
		if (next !== method.label)
			onSave({
				method,
				label: next,
				payingEntityId: method.payingEntityId,
				archived,
			});
	};
	return (
		<li
			className={cn(
				"grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 border-l-2 py-1.5 pl-2 sm:grid-cols-[auto_minmax(0,1fr)_12rem_6.5rem_auto]",
				unmapped ? "border-amber-500 bg-amber-500/5" : "border-transparent",
				archived && "opacity-60",
			)}
		>
			<span className="inline-flex h-5 min-w-14 items-center justify-center gap-1 rounded-sm border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
				<span className="uppercase">{method.brand || "card"}</span>
				{method.last4 && <span>••{method.last4}</span>}
			</span>
			<Input
				aria-label={`Label for ${method.label}`}
				value={label}
				disabled={archived}
				onChange={(e) => setLabel(e.target.value)}
				onBlur={commitLabel}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					if (e.key === "Escape") setLabel(method.label);
				}}
				className="font-sans"
			/>
			<span className="flex items-center justify-end gap-1 sm:order-last">
				{unmapped && (
					<Tag
						tone="warning"
						title="No paying entity — reimbursement can't be computed"
					>
						unmapped
					</Tag>
				)}
				{archived && <Tag tone="neutral">archived</Tag>}
				<Button
					variant="ghost"
					size="xs"
					aria-label={
						archived ? `Restore ${method.label}` : `Archive ${method.label}`
					}
					disabled={pending}
					onClick={() =>
						onSave({
							method,
							label: method.label,
							payingEntityId: method.payingEntityId,
							archived: !archived,
						})
					}
				>
					{archived ? <IconArrowBackUp /> : <IconArchive />}
				</Button>
			</span>
			<div className="col-span-3 flex items-center gap-1.5 sm:col-span-1">
				{payer ? (
					<EntityDot color={payer.color} />
				) : (
					<IconAlertTriangle className="size-3 shrink-0 text-amber-500" />
				)}
				<Select
					aria-label={`Paying entity for ${method.label}`}
					value={method.payingEntityId ?? ""}
					disabled={archived || pending}
					onChange={(e) =>
						onSave({
							method,
							label: method.label,
							payingEntityId: e.target.value || null,
						})
					}
				>
					<option value="">— who pays this card? —</option>
					{activeEntities.map((entity) => (
						<option key={entity.id} value={entity.id}>
							Paid by {entity.name}
						</option>
					))}
				</Select>
			</div>
			<span className="col-span-3 font-mono text-[11px] tabular-nums text-muted-foreground sm:col-span-1 sm:text-right">
				{usage?.orders ?? 0} orders
				{usage?.lastUsed ? ` · ${formatDate(usage.lastUsed)}` : ""}
			</span>
		</li>
	);
}

function AddMethodForm({
	onSave,
	onCancel,
	pending,
}: {
	onSave: (input: SaveInput) => void;
	onCancel: () => void;
	pending: boolean;
}) {
	const { activeEntities } = useBootstrap();
	const [draft, setDraft] = useState({
		brand: "VISA",
		last4: "",
		label: "",
		payingEntityId: "",
	});
	const autoLabel = `${draft.brand || "Card"}${draft.last4 ? ` ••${draft.last4}` : ""}`;
	return (
		<form
			className="grid grid-cols-2 items-end gap-2 rounded-sm border border-primary/40 bg-background/40 p-2 sm:grid-cols-[6rem_5rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
			onSubmit={(e) => {
				e.preventDefault();
				onSave({
					label: draft.label.trim() || autoLabel,
					brand: draft.brand.trim(),
					last4: draft.last4,
					payingEntityId: draft.payingEntityId || null,
				});
			}}
		>
			<Field label="Brand">
				<Input
					value={draft.brand}
					maxLength={30}
					onChange={(e) =>
						setDraft({ ...draft, brand: e.target.value.toUpperCase() })
					}
				/>
			</Field>
			<Field label="Last 4">
				<Input
					value={draft.last4}
					inputMode="numeric"
					pattern="\d{0,4}"
					maxLength={4}
					onChange={(e) =>
						setDraft({ ...draft, last4: e.target.value.replace(/\D/g, "") })
					}
				/>
			</Field>
			<Field label="Label">
				<Input
					value={draft.label}
					placeholder={autoLabel}
					className="font-sans"
					onChange={(e) => setDraft({ ...draft, label: e.target.value })}
				/>
			</Field>
			<Field label="Paying entity">
				<Select
					value={draft.payingEntityId}
					onChange={(e) =>
						setDraft({ ...draft, payingEntityId: e.target.value })
					}
				>
					<option value="">— unmapped —</option>
					{activeEntities.map((entity) => (
						<option key={entity.id} value={entity.id}>
							{entity.name}
						</option>
					))}
				</Select>
			</Field>
			<div className="col-span-2 flex justify-end gap-1 sm:col-span-1">
				<Button type="submit" variant="primary" disabled={pending}>
					Add
				</Button>
				<Button variant="ghost" aria-label="Cancel" onClick={onCancel}>
					<IconX />
				</Button>
			</div>
		</form>
	);
}

export function PaymentMethodsSection({
	usage,
	highlight,
}: {
	usage: Usage;
	highlight?: boolean;
}) {
	const { data } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [adding, setAdding] = useState(false);
	const [onlyUnmapped, setOnlyUnmapped] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const all = data?.paymentMethods ?? [];
	const unmappedCount = all.filter(
		(m) => !m.archivedAt && !m.payingEntityId,
	).length;
	const archivedCount = all.filter((m) => m.archivedAt).length;
	const visible = all
		.filter((m) => showArchived || !m.archivedAt)
		.filter((m) => !onlyUnmapped || (!m.payingEntityId && !m.archivedAt))
		.sort(
			(a, b) =>
				Number(Boolean(a.payingEntityId)) - Number(Boolean(b.payingEntityId)) ||
				(usage[b.id]?.orders ?? 0) - (usage[a.id]?.orders ?? 0),
		);

	const save = useMutation({
		mutationFn: (input: SaveInput) =>
			savePaymentMethod({
				data: {
					id: input.method?.id,
					label: input.label,
					...(input.method
						? {}
						: { brand: input.brand ?? "", last4: input.last4 ?? "" }),
					payingEntityId: input.payingEntityId,
					archived: input.archived ?? Boolean(input.method?.archivedAt),
				},
			}),
		onSuccess: async (_r, input) => {
			toast.success(
				input.method
					? input.payingEntityId !== input.method.payingEntityId
						? "Paying entity updated — reimbursements recomputed"
						: "Payment method saved"
					: "Payment method added",
			);
			setAdding(false);
			await invalidate();
		},
		onError: (error) => toast.error(errorText(error)),
	});

	return (
		<Panel
			title={
				<span className="flex items-center gap-2">
					Payment methods · {all.length - archivedCount}
					{unmappedCount > 0 && (
						<Tag tone="warning">{unmappedCount} unmapped</Tag>
					)}
				</span>
			}
			className={cn(highlight && unmappedCount > 0 && "border-amber-500/50")}
			action={
				<Button size="xs" onClick={() => setAdding(true)}>
					<IconPlus /> Card
				</Button>
			}
		>
			<div className="space-y-2">
				<Callout
					tone="info"
					icon={<IconCreditCard />}
					title="The paying entity drives reimbursement"
				>
					<p>
						Cards are created automatically from captured orders (e.g. “VISA
						••4821”). Set <strong>who funds each card</strong>. When an order
						paid with a card is assigned to a <em>different</em> entity, that
						share becomes reimbursable: a business purchase on your personal
						card means the business owes you. Changing the payer recomputes
						existing orders.
					</p>
				</Callout>
				{adding && (
					<AddMethodForm
						pending={save.isPending}
						onSave={(input) => save.mutate(input)}
						onCancel={() => setAdding(false)}
					/>
				)}
				{all.length > 0 && (
					<div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
						<label className="flex items-center gap-1.5">
							<input
								type="checkbox"
								checked={onlyUnmapped}
								onChange={(e) => setOnlyUnmapped(e.target.checked)}
							/>
							Unmapped only
						</label>
						{archivedCount > 0 && (
							<label className="flex items-center gap-1.5">
								<input
									type="checkbox"
									checked={showArchived}
									onChange={(e) => setShowArchived(e.target.checked)}
								/>
								Show archived ({archivedCount})
							</label>
						)}
					</div>
				)}
				{visible.length === 0 ? (
					<p className="py-4 text-center text-xs text-muted-foreground">
						{all.length === 0
							? "No payment methods yet — they appear as orders are captured."
							: "Nothing to show."}
					</p>
				) : (
					<ul className="divide-y divide-border">
						{visible.map((method) => (
							<MethodRow
								key={`${method.id}:${method.label}`}
								method={method}
								usage={usage[method.id]}
								pending={save.isPending}
								onSave={(input) => save.mutate(input)}
							/>
						))}
					</ul>
				)}
			</div>
		</Panel>
	);
}
