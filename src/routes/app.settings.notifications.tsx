import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "#/components/app/primitives";
import { InstallAppPanel } from "#/components/automation/install-app";
import { InvoiceNinjaClaimsPanel } from "#/components/automation/invoice-ninja-claims";
import { NotificationSettingsPanel } from "#/components/automation/notification-settings";
import { WebhookEndpointsPanel } from "#/components/automation/webhook-endpoints";
import { SettingsNav } from "#/components/settings/ui";

export const Route = createFileRoute("/app/settings/notifications")({
	head: () => ({ links: [{ rel: "manifest", href: "/manifest.webmanifest" }] }),
	component: NotificationsSettingsPage,
});

function NotificationsSettingsPage() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title="Notifications & automation"
				description="Daily digest, alerts, outbound webhooks and reimbursement invoices."
			/>
			<SettingsNav />
			<div className="flex max-w-5xl flex-col gap-4 p-4">
				<NotificationSettingsPanel />
				<WebhookEndpointsPanel />
				<InvoiceNinjaClaimsPanel />
				<InstallAppPanel />
			</div>
		</div>
	);
}
