import {
	IconArrowRight,
	IconBrandGithub,
	IconKey,
	IconMail,
	IconMailCheck,
	IconStack2,
} from "@tabler/icons-react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { Button, Field, Input } from "#/components/app/primitives";
import { ThemeSelector } from "#/components/theme-selector";
import { getSessionUser } from "#/features/ledger/session.functions";
import { appName } from "#/lib/app-name";
import { authClient } from "#/lib/auth-client";
import { getAuthProviders } from "#/lib/auth-providers.functions";
import { safeInternalRedirect } from "#/lib/safe-redirect";

export const Route = createFileRoute("/")({
	validateSearch: z.object({ redirect: z.string().optional() }),
	beforeLoad: async ({ search }) => {
		if (await getSessionUser())
			throw redirect({ href: safeInternalRedirect(search.redirect) });
	},
	loader: () => getAuthProviders(),
	head: () => ({ meta: [{ title: `Sign in · ${appName}` }] }),
	component: SignIn,
});

function SignIn() {
	const providers = Route.useLoaderData();
	const { redirect: redirectTo } = Route.useSearch();
	const callbackURL = safeInternalRedirect(redirectTo);
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [sentTo, setSentTo] = useState<string | null>(null);
	const hasOAuth = providers.github || providers.oidc;
	const hasAny = hasOAuth || providers.magicLink;

	const social = async (provider: "github" | "oidc") => {
		setPending(provider);
		setError(null);
		const result = await authClient.signIn
			.social({ provider, callbackURL })
			.catch(() => null);
		if (!result || result.error) {
			setError("Sign-in could not be started. Please try again.");
			setPending(null);
		}
	};

	const sendMagicLink = async (event: FormEvent) => {
		event.preventDefault();
		const address = email.trim();
		if (!address) return;
		setPending("magic");
		setError(null);
		const result = await authClient.signIn
			.magicLink({ email: address, callbackURL })
			.catch(() => null);
		setPending(null);
		if (!result || result.error)
			setError(result?.error?.message ?? "The sign-in link could not be sent.");
		else setSentTo(address);
	};

	return (
		<main className="flex min-h-screen flex-col bg-background text-foreground">
			<div className="flex justify-end p-3">
				<ThemeSelector />
			</div>
			<div className="flex flex-1 items-start justify-center px-4 pt-[12vh] pb-16">
				<div className="w-full max-w-sm">
					<div className="mb-6 flex items-center gap-2">
						<span className="flex size-7 items-center justify-center rounded-sm border border-primary/40 bg-primary/10 text-primary">
							<IconStack2 size={16} />
						</span>
						<h1 className="text-base font-semibold tracking-tight">
							{appName}
						</h1>
					</div>
					<p className="mb-6 text-[13px] text-muted-foreground">
						Capture every purchase, assign it to the right entity, reclaim what
						you're owed.
					</p>

					<section className="rounded border border-border bg-card">
						<div className="border-b border-border px-4 py-2">
							<span className="label-caps">Sign in</span>
						</div>
						<div className="flex flex-col gap-3 p-4">
							{!hasAny && (
								<p className="text-xs text-muted-foreground">
									No sign-in method is configured. Set GitHub or OIDC
									credentials, or MAGIC_LINK_ENABLED=true, on the server.
								</p>
							)}

							{providers.magicLink &&
								(sentTo ? (
									<output className="flex gap-2.5 rounded-sm border border-emerald-500/35 bg-emerald-500/10 p-3">
										<IconMailCheck
											size={16}
											className="mt-0.5 shrink-0 text-emerald-500"
										/>
										<div className="min-w-0 text-xs">
											<div className="font-semibold">Check your inbox</div>
											<p className="mt-0.5 text-muted-foreground">
												We sent a sign-in link to{" "}
												<span className="font-mono text-foreground">
													{sentTo}
												</span>
												.
											</p>
											<button
												type="button"
												className="mt-1.5 text-[11px] text-primary hover:underline"
												onClick={() => setSentTo(null)}
											>
												Use a different email
											</button>
										</div>
									</output>
								) : (
									<form
										className="flex flex-col gap-2"
										onSubmit={sendMagicLink}
									>
										<Field label="Email">
											<Input
												type="email"
												required
												autoComplete="email"
												placeholder="you@example.com"
												className="h-8"
												value={email}
												onChange={(event) => setEmail(event.target.value)}
											/>
										</Field>
										<Button
											type="submit"
											variant="primary"
											size="md"
											disabled={pending !== null}
										>
											<IconMail /> Email me a sign-in link
										</Button>
									</form>
								))}

							{providers.magicLink && hasOAuth && (
								<div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
									<span className="h-px flex-1 bg-border" />
									or
									<span className="h-px flex-1 bg-border" />
								</div>
							)}

							{providers.github && (
								<Button
									size="md"
									disabled={pending !== null}
									onClick={() => void social("github")}
								>
									<IconBrandGithub /> Continue with GitHub
									<IconArrowRight className="ml-auto opacity-60" />
								</Button>
							)}
							{providers.oidc && (
								<Button
									size="md"
									disabled={pending !== null}
									onClick={() => void social("oidc")}
								>
									<IconKey /> Continue with OIDC
									<IconArrowRight className="ml-auto opacity-60" />
								</Button>
							)}

							{error && (
								<p role="alert" className="text-xs text-destructive">
									{error}
								</p>
							)}
						</div>
					</section>
				</div>
			</div>
		</main>
	);
}
