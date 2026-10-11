/** Small UI helpers shared by lifecycle components. */
import { Dialog } from "@base-ui/react/dialog";
import { IconX } from "@tabler/icons-react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "#/components/app/primitives";

export function currencyExponent(currency: string | null | undefined) {
	try {
		return (
			new Intl.NumberFormat("en", {
				style: "currency",
				currency: (currency || "USD").toUpperCase(),
			}).resolvedOptions().maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
}

/** "12.50" → 1250 (respecting zero-decimal currencies). null when invalid. */
export function parseMoneyInput(
	text: string,
	currency: string | null | undefined,
): number | null {
	const cleaned = text.replace(/[,\s]/g, "").replace(/^[^\d.-]+/, "");
	if (!/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === "" || cleaned === ".")
		return null;
	const value = Number.parseFloat(cleaned);
	if (!Number.isFinite(value)) return null;
	return Math.round(value * 10 ** currencyExponent(currency));
}

export function minorToInput(
	minor: number | null | undefined,
	currency: string | null | undefined,
) {
	if (minor == null) return "";
	const exp = currencyExponent(currency);
	return (minor / 10 ** exp).toFixed(exp);
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	onSubmit,
	children,
	error,
	submitLabel,
	pending,
	width = "32rem",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description: string;
	onSubmit: () => void;
	children: ReactNode;
	error?: string | null;
	submitLabel: string;
	pending?: boolean;
	width?: string;
}) {
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit();
	};
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
				<Dialog.Popup
					style={{ width: `min(${width}, calc(100vw - 1.5rem))` }}
					className="fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] -translate-x-1/2 flex-col overflow-hidden rounded border border-border bg-card shadow-xl"
				>
					<form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
						<header className="flex h-9 items-center justify-between border-b border-border px-3">
							<Dialog.Title className="text-sm font-semibold">
								{title}
							</Dialog.Title>
							<Dialog.Close
								aria-label="Close"
								className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<IconX className="size-4" />
							</Dialog.Close>
						</header>
						<Dialog.Description className="sr-only">
							{description}
						</Dialog.Description>
						<div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-3">
							{children}
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
								<Button type="submit" variant="primary" disabled={pending}>
									{pending ? "Saving…" : submitLabel}
								</Button>
							</div>
						</footer>
					</form>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
