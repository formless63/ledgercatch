import {
	IconAdjustmentsBolt,
	IconCamera,
	IconChartBar,
	IconFileImport,
	IconInbox,
	IconListSearch,
	IconLogout,
	IconPackages,
	IconPlugConnected,
	IconReceiptRefund,
	IconScale,
	IconSearch,
	IconSettings,
	IconShieldCheck,
	IconStack2,
	IconTargetArrow,
} from "@tabler/icons-react";
import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useNavigate,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { formatMoney, formatRelative } from "#/components/app/format";
import { EntityDot, Kbd } from "#/components/app/primitives";
import { NotificationBell } from "#/components/automation/NotificationBell";
import { CommandPalette } from "#/components/command-system";
import { ThemeSelector } from "#/components/theme-selector";
import { useBootstrap, useLedgerLive } from "#/features/ledger/hooks";
import { getSessionUser } from "#/features/ledger/session.functions";
import { appName } from "#/lib/app-name";
import { authClient } from "#/lib/auth-client";
import { safeInternalRedirect } from "#/lib/safe-redirect";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/app")({
	beforeLoad: async ({ location }) => {
		const user = await getSessionUser();
		if (!user)
			throw redirect({
				to: "/",
				search: { redirect: safeInternalRedirect(location.href) },
			});
		return { user };
	},
	component: AppShell,
});

type NavItem = {
	to:
		| "/app"
		| "/app/orders"
		| "/app/import"
		| "/app/capture"
		| "/app/items"
		| "/app/assets"
		| "/app/reimbursements"
		| "/app/reconcile"
		| "/app/budgets"
		| "/app/insights"
		| "/app/rules"
		| "/app/captures"
		| "/app/settings";
	label: string;
	icon: ReactNode;
	exact?: boolean;
	badge?: ReactNode;
};

function NavLink({
	item,
	onNavigate,
}: {
	item: NavItem;
	onNavigate?: () => void;
}) {
	return (
		<Link
			to={item.to}
			onClick={onNavigate}
			activeOptions={{ exact: item.exact ?? false }}
			className="group flex h-7 items-center gap-2 rounded-sm border-l-2 border-transparent px-2 text-[13px] text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
			activeProps={{
				className:
					"!border-primary bg-sidebar-accent !text-foreground font-medium",
			}}
		>
			<span className="[&_svg]:size-4">{item.icon}</span>
			<span className="flex-1 truncate">{item.label}</span>
			{item.badge}
		</Link>
	);
}

function AppShell() {
	const { user } = Route.useRouteContext();
	const navigate = useNavigate();
	const bootstrap = useBootstrap();
	useLedgerLive();
	const [search, setSearch] = useState("");
	const [mobileNav, setMobileNav] = useState(false);
	const counts = bootstrap.data?.counts;
	const pending = counts?.pendingReimbursement ?? [];

	const nav: NavItem[] = [
		{
			to: "/app",
			label: "Inbox",
			icon: <IconInbox />,
			exact: true,
			badge: counts?.inbox ? (
				<span className="rounded-sm bg-primary/15 px-1 font-mono text-[10px] font-semibold text-primary">
					{counts.inbox}
				</span>
			) : null,
		},
		{ to: "/app/orders", label: "Orders", icon: <IconPackages /> },
		{ to: "/app/items", label: "Items", icon: <IconListSearch /> },
		{ to: "/app/assets", label: "Assets", icon: <IconShieldCheck /> },
		{ to: "/app/import", label: "Import", icon: <IconFileImport /> },
		{ to: "/app/capture", label: "Capture receipt", icon: <IconCamera /> },
		{
			to: "/app/reimbursements",
			label: "Reimbursements",
			icon: <IconReceiptRefund />,
			badge: pending[0] ? (
				<span className="font-mono text-[10px] text-amber-600 dark:text-amber-400">
					{formatMoney(pending[0].total, pending[0].currency, {
						compact: true,
					})}
				</span>
			) : null,
		},
		{ to: "/app/reconcile", label: "Reconcile", icon: <IconScale /> },
		{ to: "/app/budgets", label: "Budgets", icon: <IconTargetArrow /> },
		{ to: "/app/insights", label: "Insights", icon: <IconChartBar /> },
		{ to: "/app/rules", label: "Rules", icon: <IconAdjustmentsBolt /> },
		{
			to: "/app/captures",
			label: "Captures",
			icon: <IconStack2 />,
			badge: counts?.capturesNeedingAttention ? (
				<span className="rounded-sm bg-amber-500/15 px-1 font-mono text-[10px] font-semibold text-amber-600 dark:text-amber-400">
					{counts.capturesNeedingAttention}
				</span>
			) : null,
		},
		{ to: "/app/settings", label: "Settings", icon: <IconSettings /> },
	];

	const go = (to: NavItem["to"]) => () => {
		void navigate({ to });
	};

	const lastCapture = bootstrap.data?.lastCapture;
	const sidebar = (
		<div className="flex h-full flex-col">
			<nav className="flex flex-col gap-0.5 p-2">
				<div className="label-caps px-2 pb-1 pt-2">Workspace</div>
				{nav.map((item) => (
					<NavLink
						key={item.to}
						item={item}
						onNavigate={() => setMobileNav(false)}
					/>
				))}
			</nav>
			{bootstrap.activeEntities.length > 0 && (
				<div className="border-t border-sidebar-border p-2">
					<div className="label-caps px-2 pb-1 pt-1">Entities</div>
					{bootstrap.activeEntities.map((entity) => (
						<Link
							key={entity.id}
							to="/app/orders"
							search={{ entity: entity.id }}
							onClick={() => setMobileNav(false)}
							className="flex h-6 items-center gap-2 rounded-sm px-2 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
						>
							<EntityDot color={entity.color} />
							<span className="truncate">{entity.name}</span>
						</Link>
					))}
				</div>
			)}
			<div className="mt-auto border-t border-sidebar-border p-3">
				<Link
					to="/app/settings/extension"
					className="flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"
				>
					<IconPlugConnected className="size-3.5" />
					<span
						className={cn(
							"size-1.5 rounded-full",
							lastCapture ? "bg-emerald-500" : "bg-muted-foreground/50",
						)}
					/>
					<span className="truncate font-mono">
						{lastCapture
							? `Last capture ${formatRelative(lastCapture.receivedAt)}`
							: "Extension not connected"}
					</span>
				</Link>
			</div>
		</div>
	);

	return (
		<>
			<CommandPalette
				commands={[
					...nav.map((item) => ({
						id: `nav-${item.to}`,
						label: `Go to ${item.label}`,
						execute: go(item.to),
					})),
					{
						id: "connections",
						label: "Accounting connections",
						keywords: ["custom HTTP", "invoice ninja", "export"],
						execute: () => void navigate({ to: "/app/settings/connections" }),
					},
					{
						id: "extension",
						label: "Browser extension setup",
						keywords: ["api key", "install"],
						execute: () => void navigate({ to: "/app/settings/extension" }),
					},
				]}
			/>
			<div className="flex h-screen flex-col bg-background text-foreground">
				<header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
					<button
						type="button"
						className="rounded-sm p-1 text-muted-foreground hover:bg-accent md:hidden"
						aria-label="Toggle navigation"
						onClick={() => setMobileNav((open) => !open)}
					>
						<IconStack2 className="size-4" />
					</button>
					<Link to="/app" className="flex items-center gap-2">
						<span className="grid size-6 place-items-center rounded-sm bg-primary font-mono text-[11px] font-bold text-primary-foreground">
							{appName
								.split(/\s+/)
								.map((word) => word[0])
								.join("")
								.slice(0, 2)
								.toUpperCase()}
						</span>
						<span className="hidden font-mono text-xs font-semibold uppercase tracking-[0.12em] sm:block">
							{appName}
						</span>
					</Link>
					<form
						className="relative mx-auto w-full max-w-md"
						onSubmit={(event) => {
							event.preventDefault();
							void navigate({
								to: "/app/orders",
								search: search.trim() ? { q: search.trim() } : {},
							});
						}}
					>
						<IconSearch className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search orders, items, SKUs, stores…"
							className="h-7 w-full rounded-sm border border-input bg-background pl-7 pr-12 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
						/>
						<span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
							<Kbd>⌘K</Kbd>
						</span>
					</form>
					<div className="flex items-center gap-2">
						<NotificationBell />
						<ThemeSelector />
						<span className="hidden max-w-40 truncate text-xs text-muted-foreground lg:block">
							{user.email}
						</span>
						<button
							type="button"
							aria-label="Sign out"
							className="rounded-sm border border-border p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							onClick={async () => {
								await authClient.signOut();
								window.location.href = "/";
							}}
						>
							<IconLogout className="size-4" />
						</button>
					</div>
				</header>
				<div className="flex min-h-0 flex-1">
					<aside className="hidden w-52 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
						{sidebar}
					</aside>
					{mobileNav && (
						<div className="fixed inset-0 top-11 z-40 md:hidden">
							<button
								type="button"
								aria-label="Close navigation"
								className="absolute inset-0 bg-black/50"
								onClick={() => setMobileNav(false)}
							/>
							<aside className="relative h-full w-60 border-r border-sidebar-border bg-sidebar">
								{sidebar}
							</aside>
						</div>
					)}
					<main className="min-w-0 flex-1 overflow-auto">
						<Outlet />
					</main>
				</div>
			</div>
		</>
	);
}
