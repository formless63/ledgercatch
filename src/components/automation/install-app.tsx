/** PWA / Offline capability panel (install + update), wrapped in app styling. */
import { Panel } from "#/components/app/primitives";
import { PwaPanel } from "#/integrations/pwa-offline/PwaPanel";

export function InstallAppPanel() {
	return (
		<Panel
			title="Install app"
			bodyClassName="text-xs [&_button]:mr-1.5 [&_button]:mt-2 [&_button]:inline-flex [&_button]:h-6 [&_button]:items-center [&_button]:rounded-sm [&_button]:border [&_button]:border-border [&_button]:bg-secondary [&_button]:px-2 [&_button:disabled]:opacity-50 [&_h2]:sr-only [&_p]:mt-1 [&_p]:text-muted-foreground"
		>
			<PwaPanel />
		</Panel>
	);
}
