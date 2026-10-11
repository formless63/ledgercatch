/** "Add order manually" dialog (createManualOrder). */
import { Dialog } from "@base-ui/react/dialog";
import { IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Textarea } from "#/components/app/primitives";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import { createManualOrder } from "#/features/ledger/ledger.functions";
import {
	CategorySelect,
	EntitySelect,
	errorMessage,
	PaymentMethodSelect,
} from "./shared";

type ItemDraft = {
	key: number;
	title: string;
	quantity: string;
	total: string;
};

const DECIMAL = /^-?\d+(\.\d{1,2})?$/;

function today() {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60_000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const emptyForm = () => ({
	merchantName: "",
	externalOrderId: "",
	orderDate: today(),
	currency: "USD",
	total: "",
	tax: "",
	shipping: "",
	entityId: null as string | null,
	categoryId: null as string | null,
	paymentMethodId: null as string | null,
	notes: "",
});

export function ManualOrderDialog({
	open,
	onOpenChange,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (orderId: string) => void;
}) {
	const { activeEntities, activeCategories, data } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const [form, setForm] = useState(emptyForm);
	const [items, setItems] = useState<ItemDraft[]>([]);
	const [error, setError] = useState<string | null>(null);

	const set = <K extends keyof ReturnType<typeof emptyForm>>(
		key: K,
		value: ReturnType<typeof emptyForm>[K],
	) => setForm((current) => ({ ...current, [key]: value }));

	const create = useMutation({
		mutationFn: () =>
			createManualOrder({
				data: {
					merchantName: form.merchantName.trim(),
					externalOrderId: form.externalOrderId.trim() || undefined,
					orderDate: form.orderDate,
					currency: form.currency.trim().toUpperCase(),
					total: form.total.trim(),
					tax: form.tax.trim() || undefined,
					shipping: form.shipping.trim() || undefined,
					entityId: form.entityId,
					categoryId: form.categoryId,
					paymentMethodId: form.paymentMethodId,
					notes: form.notes.trim() || undefined,
					items: items
						.filter((item) => item.title.trim())
						.map((item) => ({
							title: item.title.trim(),
							quantity: Number(item.quantity) || 1,
							total: item.total.trim() || undefined,
						})),
				},
			}),
		onSuccess: (result) => {
			toast.success("Order added to inbox");
			void invalidate();
			setForm(emptyForm());
			setItems([]);
			onOpenChange(false);
			onCreated?.(result.id);
		},
		onError: (cause) => setError(errorMessage(cause)),
	});

	const submit = (event: FormEvent) => {
		event.preventDefault();
		setError(null);
		const amounts = [
			form.total,
			form.tax,
			form.shipping,
			...items.map((i) => i.total),
		]
			.map((value) => value.trim())
			.filter(Boolean);
		if (!form.merchantName.trim()) return setError("Merchant is required.");
		if (!form.total.trim()) return setError("Total is required.");
		if (amounts.some((value) => !DECIMAL.test(value)))
			return setError("Amounts must be decimals like 12.34.");
		if (!/^[A-Za-z]{3}$/.test(form.currency.trim()))
			return setError("Currency must be a 3-letter code.");
		create.mutate();
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
				<Dialog.Popup className="fixed left-1/2 top-[6vh] z-50 flex max-h-[88vh] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded border border-border bg-card shadow-xl">
					<form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
						<header className="flex h-9 items-center justify-between border-b border-border px-3">
							<Dialog.Title className="text-sm font-semibold">
								Add order manually
							</Dialog.Title>
							<Dialog.Close
								aria-label="Close"
								className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<IconX className="size-4" />
							</Dialog.Close>
						</header>
						<Dialog.Description className="sr-only">
							Record an order that was not captured by the extension.
						</Dialog.Description>
						<div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-4">
							<Field label="Merchant" className="col-span-2">
								<Input
									autoFocus
									required
									value={form.merchantName}
									onChange={(e) => set("merchantName", e.target.value)}
									placeholder="Hardware store"
								/>
							</Field>
							<Field label="Order #" hint="Optional" className="col-span-2">
								<Input
									value={form.externalOrderId}
									onChange={(e) => set("externalOrderId", e.target.value)}
									placeholder="Generated if empty"
								/>
							</Field>
							<Field label="Date" className="col-span-1">
								<Input
									type="date"
									required
									value={form.orderDate}
									onChange={(e) => set("orderDate", e.target.value)}
								/>
							</Field>
							<Field label="Currency" className="col-span-1">
								<Input
									value={form.currency}
									maxLength={3}
									onChange={(e) =>
										set("currency", e.target.value.toUpperCase())
									}
								/>
							</Field>
							<Field label="Total" className="col-span-2 sm:col-span-2">
								<Input
									inputMode="decimal"
									required
									value={form.total}
									onChange={(e) => set("total", e.target.value)}
									placeholder="0.00"
								/>
							</Field>
							<Field label="Tax" className="col-span-1">
								<Input
									inputMode="decimal"
									value={form.tax}
									onChange={(e) => set("tax", e.target.value)}
									placeholder="0.00"
								/>
							</Field>
							<Field label="Shipping" className="col-span-1">
								<Input
									inputMode="decimal"
									value={form.shipping}
									onChange={(e) => set("shipping", e.target.value)}
									placeholder="0.00"
								/>
							</Field>
							<Field label="Entity" className="col-span-2">
								<EntitySelect
									label="Entity"
									value={form.entityId}
									entities={activeEntities}
									onChange={(value) => set("entityId", value)}
								/>
							</Field>
							<Field label="Category" className="col-span-2">
								<CategorySelect
									label="Category"
									value={form.categoryId}
									categories={activeCategories}
									entityId={form.entityId}
									onChange={(value) => set("categoryId", value)}
								/>
							</Field>
							<Field label="Payment method" className="col-span-2">
								<PaymentMethodSelect
									label="Payment method"
									value={form.paymentMethodId}
									methods={data?.paymentMethods ?? []}
									onChange={(value) => set("paymentMethodId", value)}
								/>
							</Field>
							<div className="col-span-2 sm:col-span-4">
								<div className="mb-1 flex items-center justify-between">
									<span className="label-caps">Items (optional)</span>
									<Button
										size="xs"
										variant="ghost"
										onClick={() =>
											setItems((list) => [
												...list,
												{
													key: Date.now(),
													title: "",
													quantity: "1",
													total: "",
												},
											])
										}
									>
										<IconPlus />
										Add item
									</Button>
								</div>
								{items.length === 0 ? (
									<p className="text-[11px] text-muted-foreground">
										Without items the whole total is allocated to the order's
										entity.
									</p>
								) : (
									<ul className="flex flex-col gap-1">
										{items.map((item, index) => (
											<li key={item.key} className="flex items-center gap-1">
												<Input
													aria-label={`Item ${index + 1} title`}
													value={item.title}
													placeholder="Title"
													className="font-sans"
													onChange={(e) =>
														setItems((list) =>
															list.map((row) =>
																row.key === item.key
																	? { ...row, title: e.target.value }
																	: row,
															),
														)
													}
												/>
												<Input
													aria-label={`Item ${index + 1} quantity`}
													value={item.quantity}
													inputMode="decimal"
													className="w-14"
													onChange={(e) =>
														setItems((list) =>
															list.map((row) =>
																row.key === item.key
																	? { ...row, quantity: e.target.value }
																	: row,
															),
														)
													}
												/>
												<Input
													aria-label={`Item ${index + 1} total`}
													value={item.total}
													inputMode="decimal"
													placeholder="0.00"
													className="w-24"
													onChange={(e) =>
														setItems((list) =>
															list.map((row) =>
																row.key === item.key
																	? { ...row, total: e.target.value }
																	: row,
															),
														)
													}
												/>
												<Button
													variant="ghost"
													size="xs"
													aria-label={`Remove item ${index + 1}`}
													onClick={() =>
														setItems((list) =>
															list.filter((row) => row.key !== item.key),
														)
													}
												>
													<IconTrash />
												</Button>
											</li>
										))}
									</ul>
								)}
							</div>
							<Field label="Notes" className="col-span-2 sm:col-span-4">
								<Textarea
									value={form.notes}
									onChange={(e) => set("notes", e.target.value)}
									rows={2}
								/>
							</Field>
						</div>
						<footer className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
							<span
								role="alert"
								className="min-w-0 truncate text-[11px] text-red-600 dark:text-red-400"
							>
								{error}
							</span>
							<div className="flex gap-2">
								<Button onClick={() => onOpenChange(false)}>Cancel</Button>
								<Button
									type="submit"
									variant="primary"
									disabled={create.isPending}
								>
									{create.isPending ? "Saving…" : "Add order"}
								</Button>
							</div>
						</footer>
					</form>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
