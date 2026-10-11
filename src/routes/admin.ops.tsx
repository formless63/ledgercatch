import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { OpsPipelineDetail } from "#/components/ops/ops-pipeline-detail";
import { loadOps } from "#/integrations/ops-admin/ops.functions";
import type { OpsSummary } from "#/integrations/ops-admin/ops.server";
import { authClient } from "#/lib/auth-client";
export const Route = createFileRoute("/admin/ops")({
	loader: async () => {
		const result = await loadOps();
		if (result.status === 401)
			throw redirect({ to: "/", search: { redirect: "/admin/ops" } });
		return result;
	},
	component: OpsPage,
});
function OpsPage() {
	const initial = Route.useLoaderData();
	const [result, setResult] = useState(initial);
	const [pending, setPending] = useState(false);
	const [ready, setReady] = useState(false);
	const inFlight = useRef(false);
	const generation = useRef(0);
	useEffect(() => {
		generation.current++;
		setReady(true);
		setResult(initial);
		return () => {
			generation.current++;
		};
	}, [initial]);
	async function refresh() {
		if (inFlight.current) return;
		inFlight.current = true;
		setPending(true);
		const current = generation.current;
		try {
			const next = await loadOps();
			if (current === generation.current) setResult(next);
		} catch {
			if (current === generation.current)
				setResult({
					status: 503,
					body: {
						code: "unavailable",
						message: "Operational inspection is unavailable.",
						retryable: true,
					},
				});
		} finally {
			inFlight.current = false;
			if (current === generation.current) setPending(false);
		}
	}
	return (
		<main className="mx-auto max-w-5xl space-y-6 p-6">
			<h1 className="text-2xl font-semibold">Operational overview</h1>
			<Link to="/" className="underline">
				Home
			</Link>
			<button
				type="button"
				className="rounded border px-4 py-2"
				disabled={!ready}
				onClick={async () => {
					generation.current++;
					setReady(false);
					setResult({
						status: 401,
						body: {
							code: "unauthenticated",
							message: "Authentication is required.",
							retryable: false,
						},
					});
					await authClient.signOut();
					window.location.href = "/";
				}}
			>
				Sign out
			</button>
			<p>
				Read-only diagnostics. Cached provider metadata may be stale; this view
				is not readiness.
			</p>
			<button
				type="button"
				className="rounded border px-4 py-2"
				disabled={pending || !ready}
				onClick={refresh}
				aria-busy={pending}
			>
				{pending ? "Refreshing…" : "Refresh"}
			</button>
			{result.status !== 200 ? (
				<p role="alert">
					{"message" in result.body
						? result.body.message
						: "Operational access is denied."}
				</p>
			) : (
				<>
					<OpsCards summary={result.body as OpsSummary} />
					<OpsPipelineDetail
						refreshKey={(result.body as OpsSummary).checkedAt}
					/>
				</>
			)}
		</main>
	);
}
function OpsCards({ summary }: { summary: OpsSummary }) {
	return (
		<>
			<p>
				Last checked:{" "}
				<time dateTime={summary.checkedAt}>{summary.checkedAt}</time>
			</p>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{summary.adapters.map((card) => (
					<section
						key={card.id}
						className="rounded-lg border p-4"
						aria-label={card.title}
					>
						<h2 className="font-semibold">{card.title}</h2>
						<output>Status: {card.status}</output>
						{card.code && <p>{card.code}</p>}
						{card.counts && (
							<dl>
								{Object.entries(card.counts).map(([name, count]) => (
									<div key={name}>
										<dt>{name}</dt>
										<dd>{count}</dd>
									</div>
								))}
							</dl>
						)}
					</section>
				))}
			</div>
		</>
	);
}
