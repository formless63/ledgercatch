import {
	IconAdjustmentsBolt,
	IconChevronRight,
	IconKey,
	IconPlugConnected,
	IconPuzzle,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageHeader, StatTile } from "#/components/app/primitives";
import { DataExport } from "#/components/backup/data-export";
import { AiPrivacyNote } from "#/components/ops/ai-privacy-note";
import { CategoriesSection } from "#/components/settings/categories-section";
import {
	EntitiesSection,
	EntityOnboarding,
} from "#/components/settings/entities-section";
import { PaymentMethodsSection } from "#/components/settings/payment-methods-section";
import { SettingsNav } from "#/components/settings/ui";
import { EntitySharing } from "#/components/sharing/entity-sharing";
import { useBootstrap } from "#/features/ledger/hooks";
import { getSettingsUsage } from "#/features/ledger/settings-ui.functions";

export const Route = createFileRoute("/app/settings/")({
	component: SettingsPage,
});

const usageKey = ["ledger", "settings-usage"] as const;

function QuickLink({
	to,
	icon,
	title,
	children,
}: {
	to:
		| "/app/settings/connections"
		| "/app/settings/extension"
		| "/app/api-keys"
		| "/app/rules";
	icon: ReactNode;
	title: string;
	children: ReactNode;
}) {
	return (
		<Link
			to={to}
			className="group flex items-start gap-2.5 rounded border border-border bg-card px-3 py-2.5 hover:border-primary/50 hover:bg-accent/40"
		>
			<span className="mt-0.5 text-muted-foreground group-hover:text-primary [&_svg]:size-4">
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-[13px] font-medium">{title}</span>
				<span className="block text-[11px] text-muted-foreground">
					{children}
				</span>
			</span>
			<IconChevronRight className="mt-0.5 size-3.5 text-muted-foreground" />
		</Link>
	);
}

function SettingsPage() {
	const bootstrap = useBootstrap();
	const usage = useQuery({
		queryKey: usageKey,
		queryFn: () => getSettingsUsage(),
	});
	const data = bootstrap.data;
	const hasEntities = (data?.entities.length ?? 0) > 0;
	const unmapped =
		data?.paymentMethods.filter((m) => !m.archivedAt && !m.payingEntityId)
			.length ?? 0;

	return (
		<div className="pb-10">
			<PageHeader
				title="Settings"
				description="Who you buy for, how spend is classified, and which card pays for what."
			/>
			<SettingsNav />
			<div className="mx-auto max-w-5xl space-y-4 p-4">
				<AiPrivacyNote />
				{bootstrap.isLoading ? (
					<p className="py-8 text-center text-xs text-muted-foreground">
						Loading…
					</p>
				) : !hasEntities ? (
					<EntityOnboarding />
				) : (
					<>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
							<StatTile
								label="Entities"
								value={bootstrap.activeEntities.length}
							/>
							<StatTile
								label="Categories"
								value={bootstrap.activeCategories.length}
							/>
							<StatTile
								label="Cards"
								value={
									data?.paymentMethods.filter((m) => !m.archivedAt).length ?? 0
								}
							/>
							<StatTile
								label="Unmapped cards"
								value={unmapped}
								tone={unmapped > 0 ? "warning" : "success"}
								hint={unmapped > 0 ? "Set a paying entity below" : "All set"}
							/>
						</div>
						<div className="grid gap-4 lg:grid-cols-2">
							<EntitiesSection
								entityOrders={usage.data?.entityOrders ?? {}}
								entityConnections={usage.data?.entityConnections ?? {}}
							/>
							<CategoriesSection
								categoryUses={usage.data?.categoryUses ?? {}}
							/>
						</div>
						<PaymentMethodsSection
							usage={usage.data?.paymentMethodUsage ?? {}}
							highlight
						/>
					</>
				)}
				<div className="grid gap-2 sm:grid-cols-2">
					<QuickLink
						to="/app/settings/connections"
						icon={<IconPlugConnected />}
						title="Accounting connections"
					>
						Export expenses to custom HTTP or Invoice Ninja, map accounts.
					</QuickLink>
					<QuickLink
						to="/app/settings/extension"
						icon={<IconPuzzle />}
						title="Browser extension"
					>
						Install for Chrome/Brave and connect it with a key.
					</QuickLink>
					<QuickLink
						to="/app/rules"
						icon={<IconAdjustmentsBolt />}
						title="Rules"
					>
						Auto-assign entity, category and reimbursement.
					</QuickLink>
					<QuickLink to="/app/api-keys" icon={<IconKey />} title="API keys">
						Manage and revoke machine credentials.
					</QuickLink>
				</div>
				{hasEntities && <EntitySharing />}
				<DataExport />
			</div>
		</div>
	);
}
