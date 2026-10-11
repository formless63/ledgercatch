import { Dialog } from "@base-ui/react/dialog";
import { type RegisterableHotkey, useHotkey } from "@tanstack/react-hotkeys";
import { useEffect, useMemo, useRef, useState } from "react";

export type AppCommand = {
	id: string;
	label: string;
	keywords?: readonly string[];
	disabled?: boolean;
	execute: () => void | Promise<void>;
};

export function createCommandRegistry(initial: readonly AppCommand[] = []) {
	const commands = new Map(
		initial.map((command) => [
			command.id,
			{ command, token: Symbol(command.id) },
		]),
	);
	return {
		register(command: AppCommand) {
			const token = Symbol(command.id);
			commands.set(command.id, { command, token });
			return () => {
				if (commands.get(command.id)?.token === token)
					commands.delete(command.id);
			};
		},
		list: () => [...commands.values()].map(({ command }) => command),
	};
}

export function CommandPalette({
	commands,
	open: controlledOpen,
	onOpenChange,
	shortcut = "Mod+K",
	label = "Command menu",
	triggerLabel = "Open command menu",
}: {
	commands: readonly AppCommand[];
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	shortcut?: string;
	label?: string;
	triggerLabel?: string;
}) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const open = controlledOpen ?? uncontrolledOpen;
	// biome-ignore lint/correctness/useExhaustiveDependencies: presentation generation intentionally tracks open transitions.
	useEffect(() => {
		runToken.current += 1;
	}, [open]);
	const setOpen = (value: boolean) => {
		if (value !== open) runToken.current += 1;
		if (controlledOpen === undefined) setUncontrolledOpen(value);
		onOpenChange?.(value);
	};
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const mounted = useRef(true);
	const runToken = useRef(0);
	const running = useRef(false);
	const filtered = useMemo(
		() =>
			commands.filter(
				(command) =>
					!command.disabled &&
					[command.label, ...(command.keywords ?? [])].some((value) =>
						value.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
					),
			),
		[commands, query],
	);
	useHotkey(shortcut as RegisterableHotkey, () => setOpen(true), {
		ignoreInputs: true,
	});
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			runToken.current += 1;
		};
	}, []);
	useEffect(() => {
		if (!open) return;
		const id = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, [open]);
	const run = async (command: AppCommand) => {
		if (running.current) return;
		running.current = true;
		const token = ++runToken.current;
		setPending(command.id);
		setError(null);
		try {
			await command.execute();
			if (mounted.current && token === runToken.current) setOpen(false);
		} catch (cause) {
			if (mounted.current && token === runToken.current)
				setError(cause instanceof Error ? cause.message : "Command failed");
		} finally {
			running.current = false;
			if (mounted.current) setPending(null);
		}
	};
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger className="sr-only">{triggerLabel}</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
				<Dialog.Popup
					className="fixed left-1/2 top-1/4 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border bg-background shadow-xl"
					onKeyDown={(event) => {
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setActive((value) => Math.min(value + 1, filtered.length - 1));
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setActive((value) => Math.max(value - 1, 0));
						}
						if (
							event.key === "Enter" &&
							event.target === inputRef.current &&
							filtered[active]
						) {
							event.preventDefault();
							void run(filtered[active]);
						}
					}}
				>
					<Dialog.Title className="sr-only">{label}</Dialog.Title>
					<Dialog.Description className="sr-only">
						Search and run an application command.
					</Dialog.Description>
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
						aria-label="Search commands"
						role="combobox"
						aria-controls="command-palette-options"
						aria-expanded={open}
						aria-activedescendant={
							filtered[active] ? `command-${filtered[active].id}` : undefined
						}
						placeholder="Type a command…"
						className="w-full border-b bg-transparent px-4 py-3 outline-none"
					/>
					<div
						id="command-palette-options"
						role="listbox"
						aria-label={label}
						className="p-2"
					>
						{filtered.map((command, index) => (
							<button
								key={command.id}
								type="button"
								role="option"
								id={`command-${command.id}`}
								disabled={pending !== null}
								aria-selected={index === active}
								className="block w-full rounded-md px-3 py-2 text-left aria-selected:bg-accent"
								onMouseEnter={() => setActive(index)}
								onFocus={() => setActive(index)}
								onClick={() => {
									void run(command);
								}}
							>
								{command.label}
								{pending === command.id && " (Running…)"}
							</button>
						))}
						{filtered.length === 0 && (
							<p className="p-3 text-sm text-muted-foreground">
								No commands found.
							</p>
						)}
					</div>
					{error && (
						<p
							role="alert"
							className="border-t px-4 py-2 text-sm text-destructive"
						>
							{error}
						</p>
					)}
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
