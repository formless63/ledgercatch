import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { SharedShellHeader } from "#/components/sharing/portal";
import { getSessionUser } from "#/features/ledger/session.functions";
import { appName } from "#/lib/app-name";
import { authClient } from "#/lib/auth-client";
import { safeInternalRedirect } from "#/lib/safe-redirect";

/** Read-only portal for share grantees (accountants / bookkeepers). */
export const Route = createFileRoute("/share")({
	beforeLoad: async ({ location }) => {
		const user = await getSessionUser();
		if (!user)
			throw redirect({
				to: "/",
				search: { redirect: safeInternalRedirect(location.href, "/share") },
			});
		return { user };
	},
	head: () => ({ meta: [{ title: `Shared books · ${appName}` }] }),
	component: ShareShell,
});

function ShareShell() {
	const { user } = Route.useRouteContext();
	return (
		<div className="flex min-h-screen flex-col bg-background text-foreground">
			<SharedShellHeader
				appLabel={appName}
				email={user.email}
				onSignOut={async () => {
					await authClient.signOut();
					window.location.href = "/";
				}}
			/>
			<main className="min-w-0 flex-1">
				<Outlet />
			</main>
		</div>
	);
}
