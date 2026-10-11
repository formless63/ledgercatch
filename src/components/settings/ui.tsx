/** Small settings-specific UI helpers built on the app primitives. */
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { ENTITY_STYLES } from "#/components/app/format";
import { Button } from "#/components/app/primitives";
import { ENTITY_COLOR_OPTIONS } from "#/features/ledger/inputs";
import { cn } from "#/lib/utils";

export type EntityColor = (typeof ENTITY_COLOR_OPTIONS)[number];

export function errorText(error: unknown) {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function Switch({
	checked,
	onChange,
	label,
	disabled,
	className,
}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	label: string;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50",
				checked
					? "border-primary bg-primary/80"
					: "border-border bg-muted hover:bg-accent",
				className,
			)}
		>
			<span
				className={cn(
					"inline-block size-2.5 rounded-full bg-background transition-transform",
					checked ? "translate-x-3.5" : "translate-x-0.5",
				)}
			/>
		</button>
	);
}

export function ColorPicker({
	value,
	onChange,
	label = "Color",
}: {
	value: string;
	onChange: (color: EntityColor) => void;
	label?: string;
}) {
	const name = useId();
	return (
		<fieldset className="flex flex-wrap gap-1">
			<legend className="sr-only">{label}</legend>
			{ENTITY_COLOR_OPTIONS.map((color) => (
				<label
					key={color}
					title={color}
					className={cn(
						"grid size-6 cursor-pointer place-items-center rounded-sm border has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
						value === color
							? "border-foreground"
							: "border-transparent hover:border-border",
					)}
				>
					<input
						type="radio"
						name={name}
						value={color}
						aria-label={color}
						checked={value === color}
						onChange={() => onChange(color)}
						className="sr-only"
					/>
					<span
						className={cn("size-3.5 rounded-full", ENTITY_STYLES[color]?.dot)}
					/>
				</label>
			))}
		</fieldset>
	);
}

export function CopyButton({
	value,
	label = "Copy",
	size = "sm",
}: {
	value: string;
	label?: string;
	size?: "xs" | "sm" | "md";
}) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size={size}
			aria-label={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch {
					toast.error("Clipboard unavailable — select and copy manually");
				}
			}}
		>
			{copied ? <IconCheck /> : <IconCopy />}
			{copied ? "Copied" : label}
		</Button>
	);
}

/** Copyable mono value box. */
export function SecretBox({ value, label }: { value: string; label: string }) {
	return (
		<div className="flex min-w-0 items-stretch gap-1.5">
			<code
				title={label}
				className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs"
			>
				{value}
			</code>
			<CopyButton value={value} />
		</div>
	);
}

export function Callout({
	tone = "info",
	icon,
	title,
	children,
	className,
}: {
	tone?: "info" | "warning" | "danger" | "success";
	icon?: ReactNode;
	title?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex gap-2 rounded-sm border px-3 py-2 text-xs [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0",
				tone === "info" && "border-cyan-500/30 bg-cyan-500/8",
				tone === "warning" && "border-amber-500/35 bg-amber-500/8",
				tone === "danger" && "border-red-500/35 bg-red-500/8",
				tone === "success" && "border-emerald-500/35 bg-emerald-500/8",
				className,
			)}
		>
			{icon && (
				<span
					className={cn(
						tone === "info" && "text-cyan-600 dark:text-cyan-400",
						tone === "warning" && "text-amber-600 dark:text-amber-400",
						tone === "danger" && "text-red-600 dark:text-red-400",
						tone === "success" && "text-emerald-600 dark:text-emerald-400",
					)}
				>
					{icon}
				</span>
			)}
			<div className="min-w-0 space-y-1 text-muted-foreground">
				{title && <div className="font-semibold text-foreground">{title}</div>}
				{children}
			</div>
		</div>
	);
}

const SETTINGS_TABS = [
	{ to: "/app/settings", label: "Ledger", exact: true },
	{ to: "/app/settings/connections", label: "Connections" },
	{ to: "/app/settings/extension", label: "Extension" },
	{ to: "/app/settings/sources", label: "Sources" },
	{ to: "/app/settings/notifications", label: "Notifications" },
	{ to: "/app/api-keys", label: "API keys" },
] as const;

/** Sub-navigation shared by every settings page. */
export function SettingsNav() {
	return (
		<nav
			aria-label="Settings sections"
			className="flex gap-0.5 overflow-x-auto border-b border-border px-4"
		>
			{SETTINGS_TABS.map((tab) => (
				<Link
					key={tab.to}
					to={tab.to}
					activeOptions={{
						exact: "exact" in tab ? tab.exact : false,
						includeSearch: false,
					}}
					className="-mb-px whitespace-nowrap border-b-2 border-transparent px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground"
					activeProps={{
						className: "!border-primary !text-foreground font-medium",
					}}
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}
