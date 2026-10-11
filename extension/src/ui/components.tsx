import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}

export function Panel(props: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<section className={cx("rounded-sm border border-line bg-panel", props.className)}>
			{(props.title || props.right) && (
				<header className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
					<span className="label-mono">{props.title}</span>
					{props.right}
				</header>
			)}
			<div className="p-2.5">{props.children}</div>
		</section>
	);
}

export function Label(props: { children: ReactNode; className?: string }) {
	return <span className={cx("label-mono", props.className)}>{props.children}</span>;
}

export function Mono(props: { children: ReactNode; className?: string; title?: string }) {
	return (
		<span className={cx("font-mono text-[12px]", props.className)} title={props.title}>
			{props.children}
		</span>
	);
}

type Tone = "accent" | "ok" | "warn" | "bad" | "muted";

const DOT: Record<Tone, string> = {
	accent: "bg-accent",
	ok: "bg-ok",
	warn: "bg-warn",
	bad: "bg-bad",
	muted: "bg-muted",
};
const TEXT: Record<Tone, string> = {
	accent: "text-accent",
	ok: "text-ok",
	warn: "text-warn",
	bad: "text-bad",
	muted: "text-muted",
};

export function StatusPill(props: { tone: Tone; children: ReactNode }) {
	return (
		<span
			className={cx(
				"inline-flex items-center gap-1.5 rounded-xs border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
				TEXT[props.tone],
			)}
		>
			<span className={cx("size-1.5 rounded-full", DOT[props.tone])} />
			{props.children}
		</span>
	);
}

export function toneText(tone: Tone): string {
	return TEXT[tone];
}

type Variant = "primary" | "default" | "danger" | "ghost";

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode }) {
	const { variant = "default", icon, className, children, ...rest } = props;
	const styles: Record<Variant, string> = {
		primary: "bg-accent text-accent-ink border-accent hover:brightness-110",
		default: "bg-raised text-fg border-line hover:border-accent hover:text-accent",
		danger: "bg-raised text-bad border-line hover:border-bad",
		ghost: "bg-transparent text-muted border-transparent hover:text-fg",
	};
	return (
		<button
			type="button"
			{...rest}
			className={cx(
				"inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-sm border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				styles[variant],
				className,
			)}
		>
			{icon}
			{children}
		</button>
	);
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
	return (
		<label className={cx("flex cursor-pointer items-start justify-between gap-3 py-1.5", props.disabled && "opacity-50")}>
			<span className="min-w-0">
				<span className="block text-[13px]">{props.label}</span>
				{props.hint && <span className="block text-[11px] text-muted">{props.hint}</span>}
			</span>
			<span className="relative mt-0.5 inline-flex shrink-0">
				<input
					type="checkbox"
					className="peer sr-only"
					checked={props.checked}
					disabled={props.disabled}
					onChange={(e) => props.onChange(e.target.checked)}
				/>
				<span className="h-4 w-7 rounded-xs border border-line bg-raised transition-colors peer-checked:border-accent peer-checked:bg-accent/25 peer-focus-visible:outline peer-focus-visible:outline-accent" />
				<span className="absolute left-0.5 top-0.5 size-3 rounded-[1px] bg-muted transition-transform peer-checked:translate-x-3 peer-checked:bg-accent" />
			</span>
		</label>
	);
}

export function TextField(
	props: {
		label: string;
		value: string;
		onChange: (v: string) => void;
		hint?: ReactNode;
		right?: ReactNode;
	} & Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">,
) {
	const { label, value, onChange, hint, right, className, ...rest } = props;
	return (
		<label className="block">
			<Label>{label}</Label>
			<span className="mt-1 flex items-stretch gap-1">
				<input
					{...rest}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					className={cx(
						"h-8 w-full min-w-0 rounded-sm border border-line bg-bg px-2 font-mono text-[12px] text-fg placeholder:text-muted/60 focus:border-accent focus:outline-none",
						className,
					)}
				/>
				{right}
			</span>
			{hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
		</label>
	);
}

export function Stat(props: { label: string; value: ReactNode; tone?: Tone }) {
	return (
		<div className="flex flex-col gap-0.5 rounded-xs border border-line bg-raised px-2 py-1.5">
			<Label>{props.label}</Label>
			<span className={cx("font-mono text-[16px] leading-none", props.tone ? TEXT[props.tone] : "text-fg")}>{props.value}</span>
		</div>
	);
}

export function timeAgo(ts: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}
