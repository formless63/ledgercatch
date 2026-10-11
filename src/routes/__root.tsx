import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { Toaster } from "sonner";
import { ColorModeSync } from "../components/theme-selector";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import { appName } from "../lib/app-name";
import { initialColorModeScript } from "../lib/color-mode";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: appName,
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
	notFoundComponent: () => (
		<main className="grid min-h-screen place-items-center p-6 text-center">
			<div>
				<p className="text-sm text-muted-foreground">404</p>
				<h1 className="mt-2 text-3xl font-semibold">Page not found</h1>
				<a className="mt-5 inline-block underline" href="/">
					Return home
				</a>
			</div>
		</main>
	),
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script>{initialColorModeScript()}</script>
				<HeadContent />
			</head>
			<body>
				<ColorModeSync />
				{children}
				<Toaster richColors />
				{import.meta.env.DEV && import.meta.env.VITE_DEMO !== "true" && (
					<TanStackDevtools
						config={{
							position: "bottom-right",
						}}
						plugins={[
							{
								name: "Tanstack Router",
								render: <TanStackRouterDevtoolsPanel />,
							},
							TanStackQueryDevtools,
						]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}
