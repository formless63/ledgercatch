/**
 * Dense operator UI primitives (docs/DESIGN.md). Prefer these over ad-hoc
 * styling so pages stay consistent.
 */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "#/lib/utils";
import {
	ENTITY_STYLES,
	formatMoney,
	REIMBURSEMENT_TONES,
	STORE_META,
	TONE_CLASSES,
	type Tone,
} from "./format";

export type EntityLike = {
	id: string;
	name: string;
	shortName?: string | null;
	color: string;
};

export function EntityChip({
	entity,
	short,
	className,
}: {
	entity: EntityLike | null | undefined;
	short?: boolean;
	className?: string;
}) {
	if (!entity)
		return (
			<span
				className={cn(
					"inline-flex h-[18px] items-center gap-1.5 rounded-sm border border-dashed border-border px-1.5 text-[11px] text-muted-foreground",
					className,
				)}
			>
				Unassigned
			</span>
		);
	const style = ENTITY_STYLES[entity.color] ?? ENTITY_STYLES.sky;
	return (
		<span
			title={entity.name}
			className={cn(
				"inline-flex h-[18px] max-w-full items-center gap-1.5 truncate rounded-sm border px-1.5 text-[11px] font-medium",
				style?.chip,
				className,
			)}
		>
			<span className={cn("size-1.5 shrink-0 rounded-full", style?.dot)} />
			<span className="truncate">
				{short ? entity.shortName || entity.name : entity.name}
			</span>
		</span>
	);
}

export function EntityDot({
	color,
	className,
}: {
	color: string;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				ENTITY_STYLES[color]?.dot ?? "bg-sky-400",
				className,
			)}
		/>
	);
}

export function Tag({
	tone = "neutral",
	children,
	className,
	title,
}: {
	tone?: Tone;
	children: ReactNode;
	className?: string;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide",
				TONE_CLASSES[tone],
				className,
			)}
		>
			{children}
		</span>
	);
}

export function ReimbursementTag({ status }: { status: string }) {
	const meta = REIMBURSEMENT_TONES[status] ?? REIMBURSEMENT_TONES.none;
	return <Tag tone={meta?.tone ?? "neutral"}>{meta?.label ?? status}</Tag>;
}

export function Money({
	minor,
	currency,
	className,
	compact,
	muted,
}: {
	minor: number | null | undefined;
	currency: string | null | undefined;
	className?: string;
	compact?: boolean;
	muted?: boolean;
}) {
	return (
		<span
			className={cn(
				"font-mono tabular-nums",
				muted && "text-muted-foreground",
				minor == null && "text-muted-foreground",
				className,
			)}
		>
			{formatMoney(minor, currency, { compact })}
		</span>
	);
}

export function Kbd({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<kbd
			className={cn(
				"inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground",
				className,
			)}
		>
			{children}
		</kbd>
	);
}

export function StoreMark({
	source,
	className,
}: {
	source: string;
	className?: string;
}) {
	const meta = STORE_META[source as keyof typeof STORE_META];
	return (
		<span className={cn("inline-flex items-center gap-1.5", className)}>
			<span className="inline-flex h-4 items-center rounded-[3px] bg-muted px-1 font-mono text-[9px] font-bold tracking-wider text-muted-foreground">
				{meta?.short ?? source.slice(0, 3).toUpperCase()}
			</span>
			<span className="truncate">{meta?.label ?? source}</span>
		</span>
	);
}

export function SectionLabel({
	children,
	className,
	action,
}: {
	children: ReactNode;
	className?: string;
	action?: ReactNode;
}) {
	return (
		<div className={cn("flex items-center justify-between gap-2", className)}>
			<h2 className="label-caps">{children}</h2>
			{action}
		</div>
	);
}

export function Panel({
	title,
	action,
	children,
	className,
	bodyClassName,
}: {
	title?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}) {
	return (
		<section className={cn("rounded border border-border bg-card", className)}>
			{title !== undefined && (
				<header className="flex h-8 items-center justify-between gap-2 border-b border-border px-3">
					<h2 className="label-caps truncate">{title}</h2>
					{action}
				</header>
			)}
			<div className={cn("p-3", bodyClassName)}>{children}</div>
		</section>
	);
}

export function StatTile({
	label,
	value,
	hint,
	tone,
	className,
}: {
	label: ReactNode;
	value: ReactNode;
	hint?: ReactNode;
	tone?: Tone;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"rounded border border-border bg-card px-3 py-2.5",
				className,
			)}
		>
			<div className="label-caps">{label}</div>
			<div
				className={cn(
					"mt-1 font-mono text-xl font-semibold tabular-nums tracking-tight",
					tone === "warning" && "text-amber-600 dark:text-amber-400",
					tone === "success" && "text-emerald-600 dark:text-emerald-400",
					tone === "danger" && "text-red-600 dark:text-red-400",
					tone === "primary" && "text-primary",
				)}
			>
				{value}
			</div>
			{hint && (
				<div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
			)}
		</div>
	);
}

export function EmptyState({
	icon,
	title,
	children,
	action,
	className,
}: {
	icon?: ReactNode;
	title: ReactNode;
	children?: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center gap-2 rounded border border-dashed border-border px-6 py-12 text-center",
				className,
			)}
		>
			{icon && <div className="text-muted-foreground">{icon}</div>}
			<div className="text-sm font-semibold">{title}</div>
			{children && (
				<div className="max-w-md text-xs text-muted-foreground">{children}</div>
			)}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
	primary:
		"bg-primary font-semibold text-primary-foreground hover:opacity-90 border border-primary",
	secondary:
		"border border-border bg-secondary text-secondary-foreground hover:bg-accent",
	ghost:
		"border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
	danger:
		"border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20",
};

export function Button({
	variant = "secondary",
	size = "sm",
	className,
	type = "button",
	...props
}: ComponentProps<"button"> & {
	variant?: ButtonVariant;
	size?: "xs" | "sm" | "md";
}) {
	return (
		<button
			type={type}
			className={cn(
				"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm text-xs transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
				size === "xs" && "h-5 px-1.5 text-[11px]",
				size === "sm" && "h-6 px-2",
				size === "md" && "h-8 px-3 text-[13px]",
				BUTTON_VARIANTS[variant],
				className,
			)}
			{...props}
		/>
	);
}

export const inputClass =
	"h-6 w-full rounded-sm border border-input bg-background px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
	return <input className={cn(inputClass, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
	return (
		<select
			className={cn(inputClass, "cursor-pointer pr-6 font-sans", className)}
			{...props}
		/>
	);
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	return (
		<textarea
			className={cn(inputClass, "h-auto min-h-16 py-1.5 font-sans", className)}
			{...props}
		/>
	);
}

export function Field({
	label,
	hint,
	children,
	className,
}: {
	label: ReactNode;
	hint?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: wraps its control
		<label className={cn("flex flex-col gap-1", className)}>
			<span className="label-caps">{label}</span>
			{children}
			{hint && (
				<span className="text-[11px] text-muted-foreground">{hint}</span>
			)}
		</label>
	);
}

/** Thin stacked bar showing allocation split by entity. */
export function AllocationBar({
	parts,
	className,
}: {
	parts: Array<{ color: string; amount: number; label?: string }>;
	className?: string;
}) {
	const total = parts.reduce((sum, part) => sum + Math.max(0, part.amount), 0);
	return (
		<div
			className={cn(
				"flex h-1.5 w-full overflow-hidden rounded-full bg-muted",
				className,
			)}
		>
			{total > 0 &&
				parts.map((part, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static ordering
						key={index}
						title={part.label}
						className={ENTITY_STYLES[part.color]?.bar ?? "bg-sky-400"}
						style={{ width: `${(Math.max(0, part.amount) / total) * 100}%` }}
					/>
				))}
		</div>
	);
}

export function PageHeader({
	title,
	description,
	actions,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3",
				className,
			)}
		>
			<div className="min-w-0">
				<h1 className="text-lg font-semibold tracking-tight">{title}</h1>
				{description && (
					<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
				)}
			</div>
			{actions && (
				<div className="flex flex-wrap items-center gap-2">{actions}</div>
			)}
		</div>
	);
}
