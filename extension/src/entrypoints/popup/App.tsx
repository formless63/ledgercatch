import type { OrderLookupResponse } from "@app/shared/capture";
import {
	IconAlertTriangle,
	IconCamera,
	IconCheck,
	IconClock,
	IconCloudDownload,
	IconCode,
	IconExternalLink,
	IconFileInvoice,
	IconLoader2,
	IconPackage,
	IconRefresh,
	IconSettings,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { appName } from "@/lib/app";
import { sendToBackground } from "@/lib/messaging";
import { isConfigured } from "@/lib/settings";
import type { ConnectionState, HistoryEntry, HistoryStatus } from "@/lib/state";
import { STORE_LABELS } from "@/lib/stores";
import { errorMessage, localDay } from "@/lib/util";
import { Button, cx, Label, Mono, Panel, Stat, StatusPill, timeAgo, toneText } from "@/ui/components";
import { useNow, useSettings, useStoredState } from "@/ui/hooks";
import { canPrintToPdf, describeOutcome, inspectActiveTab, snapshotHtml, type TabContext, trackPage } from "@/ui/tab";

const PAGE_TYPE_LABEL: Record<string, string> = {
	order_list: "Order list",
	order_detail: "Order detail",
	order_confirmation: "Confirmation",
	invoice: "Invoice",
	unknown: "Not an order page",
};

type Flash = { tone: "ok" | "warn" | "bad"; text: string } | null;

function openOptions() {
	void browser.runtime.openOptionsPage();
}

function ConnectionPill({ conn, configured }: { conn: ConnectionState; configured: boolean }) {
	if (!configured || conn.state === "unconfigured") return <StatusPill tone="warn">Not configured</StatusPill>;
	switch (conn.state) {
		case "ok":
			return <StatusPill tone="ok">Connected</StatusPill>;
		case "auth_error":
			return <StatusPill tone="bad">Auth error</StatusPill>;
		case "unreachable":
			return <StatusPill tone="warn">Unreachable</StatusPill>;
		default:
			return <StatusPill tone="muted">Unknown</StatusPill>;
	}
}

export function App() {
	const settings = useSettings();
	const conn = useStoredState("connection");
	const summary = useStoredState("outboxSummary");
	const stats = useStoredState("stats");
	const history = useStoredState("history");
	const paused = useStoredState("authPaused");
	const job = useStoredState("invoiceJob");
	const enrichment = useStoredState("enrichment");
	const now = useNow(15_000);

	const [tab, setTab] = useState<TabContext | null | undefined>(undefined);
	const [lookup, setLookup] = useState<OrderLookupResponse | null>(null);
	const [lookupError, setLookupError] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const [withShot, setWithShot] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [flash, setFlash] = useState<Flash>(null);

	const configured = settings ? isConfigured(settings) : false;

	useEffect(() => {
		inspectActiveTab()
			.then(setTab)
			.catch(() => setTab(null));
	}, []);

	useEffect(() => {
		if (!tab?.store || tab.orderIds.length === 0 || !configured) return;
		setLookupError(null);
		sendToBackground("orders/lookup", { source: tab.source, externalOrderIds: tab.orderIds.slice(0, 200) })
			.then(setLookup)
			.catch((err: unknown) => setLookupError(errorMessage(err)));
	}, [tab, configured]);

	useEffect(() => {
		if (!configured) return;
		sendToBackground("enrichment/refresh", null).catch(() => null);
	}, [configured]);

	const run = useCallback(async (key: string, fn: () => Promise<Flash>) => {
		setBusy(key);
		setFlash(null);
		try {
			setFlash(await fn());
		} catch (err) {
			setFlash({ tone: "bad", text: errorMessage(err) });
		} finally {
			setBusy(null);
		}
	}, []);

	const onTrack = () =>
		tab &&
		run("track", async () => {
			const outcome = await trackPage(tab, note, withShot);
			if (outcome.status === "queued") setNote("");
			return describeOutcome(outcome);
		});

	const onSnapshot = () => tab && run("snapshot", async () => describeOutcome(await snapshotHtml(tab)));

	const onInvoices = () => {
		if (!tab) return;
		const needsPrint = tab.invoices.some((c) => c.format !== "pdf");
		void run("invoices", async () => {
			const granted = !needsPrint || ((await canPrintToPdf()) && settings?.printInvoicesToPdf !== false);
			await sendToBackground("invoices/save", {
				tabId: tab.tabId,
				source: tab.source,
				pageUrl: tab.url,
				candidates: tab.invoices,
			});
			return {
				tone: "ok",
				text: granted
					? `Saving ${tab.invoices.length} invoice link(s)…`
					: `Saving ${tab.invoices.length} link(s); HTML invoices are saved as HTML documents.`,
			};
		});
	};

	const onRetry = () =>
		run("retry", async () => {
			await sendToBackground("outbox/retry", null);
			return { tone: "ok", text: "Retry started" };
		});

	const onFetchMissing = () =>
		run("enrich", async () => {
			const r = await sendToBackground("enrichment/run", null);
			if (r.message && r.fetched + r.tabs + r.skipped + r.failed === 0) return { tone: "warn", text: r.message };
			const parts = [`${r.fetched} fetched`];
			if (r.tabs) parts.push(`${r.tabs} via tab`);
			if (r.skipped) parts.push(`${r.skipped} skipped`);
			if (r.failed) parts.push(`${r.failed} failed`);
			const stopped = r.stoppedDomains.length ? ` Stopped on ${r.stoppedDomains.join(", ")}.` : "";
			return { tone: r.failed || stopped ? "warn" : "ok", text: `${parts.join(", ")}.${stopped}` };
		});

	const lookupById = useMemo(() => new Map(lookup?.orders.map((o) => [o.externalOrderId, o]) ?? []), [lookup]);
	const sentToday = stats.day === localDay(now) ? stats.sent : 0;
	// Exhausted retries are also logged as history errors; don't double count.
	const errorCount = Math.max(summary.failed, history.filter((h) => h.status === "error").length);
	const jobForTab = job && tab && job.tabId === tab.tabId ? job : null;

	return (
		<div className="flex w-[380px] flex-col gap-2 bg-bg p-2">
			<header className="flex items-center justify-between gap-2 px-0.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<IconPackage size={16} className="shrink-0 text-accent" stroke={1.75} />
					<span className="truncate text-[13px] font-semibold">{appName()}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<ConnectionPill conn={conn} configured={configured} />
					<Button variant="ghost" className="h-6 px-1" onClick={openOptions} aria-label="Options" title="Options">
						<IconSettings size={15} stroke={1.75} />
					</Button>
				</div>
			</header>

			{(!configured || conn.state === "auth_error" || paused) && settings && (
				<div className="flex items-start gap-2 rounded-sm border border-warn/50 bg-warn/10 p-2 text-[12px]">
					<IconAlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
					<div className="min-w-0 flex-1">
						{!configured
							? "Set your server URL and API key to start uploading captures."
							: "The server rejected the API key. Uploads are paused until you fix it."}{" "}
						<button type="button" className="cursor-pointer text-accent underline" onClick={openOptions}>
							Open options
						</button>
					</div>
				</div>
			)}

			<Panel
				title="Current tab"
				right={
					tab ? (
						<span className="font-mono text-[10px] uppercase text-muted">
							{STORE_LABELS[tab.source]} · {PAGE_TYPE_LABEL[tab.pageType]}
						</span>
					) : null
				}
			>
				{tab === undefined && <span className="text-muted">Inspecting…</span>}
				{tab === null && <span className="text-muted">No inspectable tab.</span>}
				{tab && (
					<div className="flex flex-col gap-2">
						<div className="truncate text-[12px] text-muted" title={tab.url}>
							{tab.title || tab.url}
						</div>

						{tab.orderIds.length > 0 && (
							<div className="flex flex-col gap-1">
								<Label>Orders on this page ({tab.orderIds.length})</Label>
								<ul className="max-h-28 overflow-y-auto rounded-xs border border-line bg-bg">
									{tab.orderIds.slice(0, 50).map((id) => {
										const hit = lookupById.get(id);
										return (
											<li
												key={id}
												className="flex items-center justify-between gap-2 border-b border-line px-2 py-1 last:border-b-0"
											>
												<Mono>{id}</Mono>
												{hit ? (
													<a
														href={hit.dashboardUrl}
														target="_blank"
														rel="noreferrer"
														className="inline-flex items-center gap-1 font-mono text-[11px] text-ok hover:underline"
													>
														<IconCheck size={12} /> Tracked
														{!hit.hasInvoice && <span className="text-warn">· no invoice</span>}
														<IconExternalLink size={11} />
													</a>
												) : lookup ? (
													<span className="font-mono text-[11px] text-muted">Not yet</span>
												) : (
													<span className="font-mono text-[11px] text-muted">
														{lookupError ? "—" : configured ? "…" : ""}
													</span>
												)}
											</li>
										);
									})}
								</ul>
								{lookupError && <span className="text-[11px] text-warn">Lookup failed: {lookupError}</span>}
							</div>
						)}

						<div className="flex flex-col gap-1.5">
							<textarea
								value={note}
								onChange={(e) => setNote(e.target.value.slice(0, 2000))}
								placeholder="Optional note (what is this order for?)"
								rows={2}
								className="w-full resize-none rounded-sm border border-line bg-bg px-2 py-1 text-[12px] placeholder:text-muted/70 focus:border-accent focus:outline-none"
							/>
							<label className="flex items-center gap-1.5 text-[11px] text-muted">
								<input
									type="checkbox"
									checked={withShot}
									onChange={(e) => setWithShot(e.target.checked)}
									className="accent-[var(--c-accent)]"
								/>
								Include screenshot of the visible area
							</label>
							<div className="flex flex-wrap gap-1.5">
								<Button
									variant="primary"
									disabled={!tab.scriptable || busy !== null}
									onClick={onTrack}
									icon={
										busy === "track" ? <IconLoader2 size={14} className="animate-spin" /> : <IconCamera size={14} />
									}
								>
									Track this page
								</Button>
								{tab.store && (
									<Button
										disabled={!tab.scriptable || busy !== null}
										onClick={onSnapshot}
										icon={
											busy === "snapshot" ? <IconLoader2 size={14} className="animate-spin" /> : <IconCode size={14} />
										}
									>
										Snapshot HTML
									</Button>
								)}
								{tab.store && tab.invoices.length > 0 && (
									<Button
										disabled={busy !== null}
										onClick={onInvoices}
										icon={
											busy === "invoices" ? (
												<IconLoader2 size={14} className="animate-spin" />
											) : (
												<IconFileInvoice size={14} />
											)
										}
									>
										Save invoices ({tab.invoices.length})
									</Button>
								)}
							</div>
							{!tab.scriptable && /^https?:/.test(tab.url) && (
								<span className="text-[11px] text-warn">
									This page blocks extensions; nothing can be captured here.
								</span>
							)}
						</div>

						{flash && <div className={cx("text-[12px]", toneText(flash.tone))}>{flash.text}</div>}

						{jobForTab && (
							<div className="flex flex-col gap-1">
								<Label>Invoices {jobForTab.finishedAt ? "· done" : "· working"}</Label>
								<ul className="max-h-28 overflow-y-auto rounded-xs border border-line bg-bg">
									{jobForTab.items.map((it) => (
										<li
											key={it.url}
											className="flex items-center justify-between gap-2 border-b border-line px-2 py-1 last:border-b-0"
										>
											<span className="truncate text-[12px]" title={it.url}>
												{it.label}
											</span>
											<span
												className={cx(
													"shrink-0 font-mono text-[10px] uppercase",
													it.status === "error"
														? "text-bad"
														: it.status === "uploaded" || it.status === "snapshot"
															? "text-ok"
															: "text-muted",
												)}
												title={it.message}
											>
												{it.status}
											</span>
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				)}
			</Panel>

			<Panel
				title="Outbox"
				right={
					<Button
						className="h-6 px-2 text-[11px]"
						disabled={busy !== null || !configured}
						onClick={onRetry}
						icon={<IconRefresh size={12} className={busy === "retry" ? "animate-spin" : undefined} />}
					>
						Retry now
					</Button>
				}
			>
				<div className="grid grid-cols-3 gap-1.5">
					<Stat label="Pending" value={summary.pending} tone={summary.pending > 0 ? "accent" : undefined} />
					<Stat label="Sent today" value={sentToday} tone={sentToday > 0 ? "ok" : undefined} />
					<Stat label="Errors" value={errorCount} tone={errorCount > 0 ? "bad" : undefined} />
				</div>
			</Panel>

			{configured && (enrichment.pending > 0 || enrichment.running || enrichment.lastRun) && (
				<Panel
					title="Missing order details"
					right={
						<Button
							className="h-6 px-2 text-[11px]"
							disabled={busy !== null || enrichment.running || enrichment.pending === 0}
							onClick={onFetchMissing}
							icon={
								busy === "enrich" || enrichment.running ? (
									<IconLoader2 size={12} className="animate-spin" />
								) : (
									<IconCloudDownload size={12} />
								)
							}
						>
							Fetch missing details ({enrichment.pending})
						</Button>
					}
				>
					<div className="text-[11px] text-muted">
						{enrichment.pending > 0
							? `${enrichment.pending} order(s) known only partially (e.g. from email). Their detail pages are fetched with your store login${settings?.fetchMissingDetails ? " every 15 min" : ""}.`
							: "Nothing to fetch."}
						{enrichment.lastRun && (
							<span className="block">
								Last run {timeAgo(enrichment.lastRun.at, now)} ago:{" "}
								{enrichment.lastRun.fetched + enrichment.lastRun.tabs} fetched
								{enrichment.lastRun.skipped ? `, ${enrichment.lastRun.skipped} skipped` : ""}
								{enrichment.lastRun.failed ? `, ${enrichment.lastRun.failed} failed` : ""}
								{enrichment.lastRun.stoppedDomains.length
									? ` (stopped: ${enrichment.lastRun.stoppedDomains.join(", ")})`
									: ""}
							</span>
						)}
					</div>
				</Panel>
			)}

			<Panel title={`Recent (${history.length})`}>
				{history.length === 0 ? (
					<span className="text-[12px] text-muted">
						Nothing captured yet. Browse your order history on a supported store.
					</span>
				) : (
					<ul className="-mx-2.5 -my-2.5 max-h-56 overflow-y-auto">
						{history.slice(0, 40).map((h) => (
							<HistoryRow key={h.id} entry={h} now={now} />
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

const STATUS_TONE: Record<HistoryStatus, "ok" | "warn" | "bad" | "muted" | "accent"> = {
	queued: "accent",
	retrying: "warn",
	sent: "ok",
	duplicate: "muted",
	skipped: "muted",
	error: "bad",
};

function HistoryRow({ entry, now }: { entry: HistoryEntry; now: number }) {
	return (
		<li
			className="flex items-start gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0"
			title={entry.message ?? entry.url}
		>
			<span className="mt-0.5 w-8 shrink-0 font-mono text-[10px] text-muted">
				<IconClock size={10} className="mr-0.5 inline" />
				{timeAgo(entry.at, now)}
			</span>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[12px]">{entry.label}</div>
				{entry.message ? (
					<div className={cx("truncate text-[11px]", entry.status === "error" ? "text-bad" : "text-muted")}>
						{entry.message}
					</div>
				) : (
					<div className="truncate text-[11px] text-muted">{entry.url}</div>
				)}
			</div>
			<span className={cx("shrink-0 font-mono text-[10px] uppercase", toneText(STATUS_TONE[entry.status]))}>
				{entry.status}
			</span>
		</li>
	);
}
