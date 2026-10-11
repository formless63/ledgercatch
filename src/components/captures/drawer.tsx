/**
 * Minimal right-side drawer (modal dialog). Escape / backdrop closes it;
 * focus moves into the panel on open and returns on close.
 */
import { IconX } from "@tabler/icons-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "#/lib/utils";

export function Drawer({
	open,
	onClose,
	title,
	subtitle,
	actions,
	children,
	className,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	subtitle?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	const titleId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement as HTMLElement | null;
		panelRef.current?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onCloseRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			previous?.focus?.();
		};
	}, [open]);

	if (!open) return null;
	return (
		<div className="fixed inset-0 z-50 flex justify-end print:hidden">
			<button
				type="button"
				aria-label="Close panel"
				tabIndex={-1}
				className="absolute inset-0 bg-black/50"
				onClick={onClose}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				className={cn(
					"relative flex h-full w-full max-w-2xl flex-col border-l border-border bg-card shadow-2xl outline-none",
					className,
				)}
			>
				<header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
					<div className="min-w-0 flex-1">
						<h2 id={titleId} className="truncate text-sm font-semibold">
							{title}
						</h2>
						{subtitle && (
							<div className="mt-0.5 truncate text-[11px] text-muted-foreground">
								{subtitle}
							</div>
						)}
					</div>
					{actions && (
						<div className="flex flex-wrap items-center justify-end gap-1.5">
							{actions}
						</div>
					)}
					<button
						type="button"
						aria-label="Close"
						onClick={onClose}
						className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<IconX className="size-4" />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-auto">{children}</div>
			</div>
		</div>
	);
}

/** Two-column key/value list for drawer metadata. */
export function MetaList({
	items,
}: {
	items: Array<{ label: string; value: ReactNode }>;
}) {
	return (
		<dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
			{items.map((item) => (
				<div key={item.label} className="contents">
					<dt className="label-caps self-center">{item.label}</dt>
					<dd className="min-w-0 break-words">{item.value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Download a text blob as a file. */
export function downloadText(fileName: string, text: string, type: string) {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
